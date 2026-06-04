// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mock DI API server that serves instrumentation configurations.
 *
 * Runs alongside the Express app inside the same container on port 3030,
 * providing /list-instrumentation-configurations and
 * /report-instrumentation-configuration-status endpoints.
 *
 * NOTE: JS DI uses V8 Inspector which only supports line-level breakpoints.
 * All configs must have LineNumber > 0 (first executable line of the function).
 * Method-level (LineNumber=0) is NOT supported in JS.
 */

const http = require('http');

// BREAKPOINT configs — all line-level (JS requirement)
const BREAKPOINT_CONFIGS = [
  // Breakpoint on processData — first executable line
  {
    InstrumentationType: 'BREAKPOINT',
    SignalType: 'SNAPSHOT',
    Location: {
      CodeLocation: {
        Language: 'JavaScript',
        CodeUnit: '',
        ClassName: '',
        MethodName: 'processData',
        FilePath: 'app.js',
        LineNumber: 32, // const result = value * 2;
      },
    },
    LocationHash: 'aabb000000000001',
    CaptureConfiguration: {
      CodeCapture: {
        CaptureReturn: true,
        CaptureStackTrace: true,
        CaptureArguments: ['value'],
        CaptureLimits: { MaxStringLength: 255 },
      },
    },
  },
  // Breakpoint on calculateSum — specific line
  {
    InstrumentationType: 'BREAKPOINT',
    SignalType: 'SNAPSHOT',
    Location: {
      CodeLocation: {
        Language: 'JavaScript',
        CodeUnit: '',
        ClassName: '',
        MethodName: 'calculateSum',
        FilePath: 'app.js',
        LineNumber: 52, // const result = a + b;
      },
    },
    LocationHash: 'aabb000000000003',
    CaptureConfiguration: {
      CodeCapture: {
        CaptureLocals: ['a', 'b', 'result'],
        CaptureStackTrace: true,
        CaptureLimits: { MaxStringLength: 255 },
      },
    },
  },
  // Breakpoint with low hit limit on limitedFunction
  {
    InstrumentationType: 'BREAKPOINT',
    SignalType: 'SNAPSHOT',
    Location: {
      CodeLocation: {
        Language: 'JavaScript',
        CodeUnit: '',
        ClassName: '',
        MethodName: 'limitedFunction',
        FilePath: 'app.js',
        LineNumber: 60, // return x * 10;
      },
    },
    LocationHash: 'aabb000000000004',
    CaptureConfiguration: {
      CodeCapture: {
        CaptureReturn: true,
        CaptureArguments: ['x'],
        CaptureStackTrace: true,
        CaptureLimits: { MaxStringLength: 255, MaxHits: 3 },
      },
    },
  },
  // Breakpoint on sharedFunction (coexists with PROBE)
  {
    InstrumentationType: 'BREAKPOINT',
    SignalType: 'SNAPSHOT',
    Location: {
      CodeLocation: {
        Language: 'JavaScript',
        CodeUnit: '',
        ClassName: '',
        MethodName: 'sharedFunction',
        FilePath: 'app.js',
        LineNumber: 67, // const processed = ...
      },
    },
    LocationHash: 'aabb000000000005',
    CaptureConfiguration: {
      CodeCapture: {
        CaptureReturn: true,
        CaptureArguments: ['data'],
        CaptureStackTrace: true,
        CaptureLimits: { MaxStringLength: 255 },
      },
    },
  },
  // String truncation limit validation (MaxStringLength=9999 -> clamped to 255)
  {
    InstrumentationType: 'BREAKPOINT',
    SignalType: 'SNAPSHOT',
    Location: {
      CodeLocation: {
        Language: 'JavaScript',
        CodeUnit: '',
        ClassName: '',
        MethodName: 'processLongString',
        FilePath: 'app.js',
        LineNumber: 76, // return longString.length;
      },
    },
    LocationHash: 'aabb000000000007',
    CaptureConfiguration: {
      CodeCapture: {
        CaptureReturn: true,
        CaptureArguments: ['longString'],
        CaptureStackTrace: false,
        CaptureLimits: { MaxStringLength: 9999 },
      },
    },
  },
  // Collection width limit validation (MaxCollectionWidth=9999 -> clamped to 20)
  {
    InstrumentationType: 'BREAKPOINT',
    SignalType: 'SNAPSHOT',
    Location: {
      CodeLocation: {
        Language: 'JavaScript',
        CodeUnit: '',
        ClassName: '',
        MethodName: 'processLargeCollection',
        FilePath: 'app.js',
        LineNumber: 84, // return largeList.length;
      },
    },
    LocationHash: 'aabb000000000008',
    CaptureConfiguration: {
      CodeCapture: {
        CaptureReturn: true,
        CaptureArguments: ['largeList'],
        CaptureStackTrace: false,
        CaptureLimits: { MaxCollectionWidth: 9999 },
      },
    },
  },
];

// PROBE configs — also line-level in JS (PROBE lineNumber forced to first executable line)
const PROBE_CONFIGS = [
  {
    InstrumentationType: 'PROBE',
    InstrumentationName: 'compute-total-probe',
    SignalType: 'SNAPSHOT',
    Location: {
      CodeLocation: {
        Language: 'JavaScript',
        CodeUnit: '',
        ClassName: '',
        MethodName: 'computeTotal',
        FilePath: 'app.js',
        LineNumber: 40, // let total = 0;
      },
    },
    LocationHash: 'aabb000000000002',
    CaptureConfiguration: {
      CodeCapture: {
        CaptureReturn: true,
        CaptureArguments: ['items'],
        CaptureStackTrace: true,
        CaptureLimits: { MaxStringLength: 255 },
      },
    },
  },
  // PROBE on sharedFunction (coexists with BREAKPOINT)
  {
    InstrumentationType: 'PROBE',
    InstrumentationName: 'shared-function-probe',
    SignalType: 'SNAPSHOT',
    Location: {
      CodeLocation: {
        Language: 'JavaScript',
        CodeUnit: '',
        ClassName: '',
        MethodName: 'sharedFunction',
        FilePath: 'app.js',
        LineNumber: 67, // const processed = ...
      },
    },
    LocationHash: 'aabb000000000006',
    CaptureConfiguration: {
      CodeCapture: {
        CaptureReturn: true,
        CaptureArguments: ['data'],
        CaptureStackTrace: true,
        CaptureLimits: { MaxStringLength: 255 },
      },
    },
  },
];

function startMockDIApi(port) {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        if (req.url === '/list-instrumentation-configurations') {
          const payload = body ? JSON.parse(body) : {};
          const type = (payload.InstrumentationType || 'BREAKPOINT').toUpperCase();
          const configs = type === 'PROBE' ? PROBE_CONFIGS : BREAKPOINT_CONFIGS;

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            Changed: true,
            SyncedAt: Date.now(),
            LatestConfigurations: configs,
          }));
        } else if (req.url === '/report-instrumentation-configuration-status') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port);
  return server;
}

module.exports = { startMockDIApi };
