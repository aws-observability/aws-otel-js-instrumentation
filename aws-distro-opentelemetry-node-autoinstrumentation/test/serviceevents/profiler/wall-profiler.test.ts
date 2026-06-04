// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import { WallProfiler } from '../../../src/serviceevents/profiler/wall-profiler';

describe('WallProfiler', function () {
  // @datadog/pprof is an optional dependency. Its availability depends on the
  // test environment (installed vs not). Probe require() at test time to pick
  // the right assertion: if installed + binary works, tryStart should succeed.
  // Otherwise, it must fail gracefully without throwing.
  let pprofUsable = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pprof = require('@datadog/pprof');
    pprofUsable = !!(pprof && pprof.time && typeof pprof.time.start === 'function');
  } catch {
    pprofUsable = false;
  }

  it('tryStart reflects @datadog/pprof availability without throwing', function () {
    const p = new WallProfiler({ intervalMicros: 10_000 });
    const started = p.tryStart();
    if (pprofUsable) {
      // Available — must either succeed, or fail cleanly (e.g., useCPED
      // rejection on older Node). Either way, no throw.
      expect([true, false]).toContain(started);
      if (started) {
        expect(p.isStarted()).toBe(true);
        p.stop();
      }
    } else {
      expect(started).toBe(false);
      expect(p.isStarted()).toBe(false);
    }
  });

  it('rotate returns null when not started', function () {
    const p = new WallProfiler({ intervalMicros: 10_000 });
    expect(p.rotate()).toBeNull();
  });

  it('stop is a no-op when not started', function () {
    const p = new WallProfiler({ intervalMicros: 10_000 });
    // Should not throw.
    p.stop();
    expect(p.isStarted()).toBe(false);
  });
});
