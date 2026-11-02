// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import { transformSource } from '../../src/serviceevents/ast-transformation';

/**
 * Regression test for the ORR finding "AST string-splicing can emit syntactically
 * invalid JS for arrow expression bodies, causing the customer module to fail to
 * load".
 *
 * Two guarantees:
 *  1. Tricky arrow expression bodies (multiply-parenthesized, object literals,
 *     sequences, ternaries) transform into syntactically VALID JS.
 *  2. Defense in depth: transformSource never returns invalid JS — if the splice
 *     somehow produced a parse error, it falls back to the original source.
 *
 * We validate (1)+(2) by re-parsing the transform output with acorn (require'd
 * from the app context, same as the production code) and asserting it parses.
 */
describe('AST transform output validity (arrow expression bodies)', function () {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const acorn = require('acorn');

  function parses(src: string): boolean {
    try {
      acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true });
      return true;
    } catch {
      return false;
    }
  }

  // Force this file to be in-scope for instrumentation regardless of default scope.
  const FILE = '/app/src/userfile.js';

  const cases: Array<{ name: string; code: string }> = [
    { name: 'object-literal arrow body (single paren)', code: 'const f = () => ({ a: 1 });' },
    { name: 'multiply-parenthesized object body', code: 'const f = () => (((  { a: 1 }  )));' },
    { name: 'sequence-expression body', code: 'const f = () => (a(), b(), c());' },
    { name: 'ternary body', code: 'const f = (x) => (x ? foo() : bar());' },
    { name: 'nested arrow expression bodies', code: 'const f = () => (g) => ((h) => ({ k: 1 }));' },
    { name: 'parenthesized arithmetic', code: 'const f = (n) => ((n + 1) * 2);' },
    { name: 'plain identifier body', code: 'const f = (x) => x;' },
    { name: 'block body (control)', code: 'function f(x) { return x + 1; }' },
    { name: 'async arrow object body', code: 'const f = async () => ({ ok: true });' },
  ];

  for (const c of cases) {
    it(`produces valid JS for: ${c.name}`, function () {
      const out = transformSource(c.code, FILE);
      expect(parses(out)).toBe(true);
    });
  }

  it('multiply-parenthesized object body is actually instrumented (not just valid)', function () {
    const out = transformSource('const f = () => (((  { a: 1 }  )));', FILE);
    // If instrumentation ran, the monitor preamble + a wrapper are present.
    // (If the re-parse guard had to fall back, the output would equal the input.)
    expect(out).toContain('__tEnter');
    expect(out).toContain('__serviceeventsRegisterFunction');
    // And it still parses.
    expect(parses(out)).toBe(true);
  });

  it('falls back to original source when input is not valid JS', function () {
    const bad = 'const f = () => {{{ this is not js';
    const out = transformSource(bad, FILE);
    // Unparseable input → returned unchanged (no preamble injected).
    expect(out).toBe(bad);
  });

  describe('directive prologue ("use strict") preservation', function () {
    it('keeps a function-level "use strict" in directive position after instrumentation', function () {
      const out = transformSource('function f() {\n  "use strict";\n  return 1;\n}', FILE);
      // Instrumentation ran...
      expect(out).toContain('__tEnter');
      // ...and the injected preamble (var __tCtx;...) was inserted AFTER the directive,
      // so "use strict" remains the first statement of the function body (directive
      // prologue intact). If it had been demoted, the preamble would precede it
      // (e.g. `{var __tCtx;...try{ "use strict";`).
      expect(out).toContain('"use strict";var __tCtx');
      expect(out).not.toMatch(/var __tCtx;[^]*?"use strict"/);
      expect(parses(out)).toBe(true);
    });

    it('preserves strict-mode runtime semantics (implicit global still throws)', function () {
      // A strict-mode function that assigns to an undeclared variable must throw
      // ReferenceError. If instrumentation demoted "use strict" to a no-op, the
      // assignment would silently create a global and NOT throw.
      const out = transformSource('function f() {\n  "use strict";\n  undeclared = 1;\n  return undeclared;\n}', FILE);
      // Evaluate the transformed function in isolation with no-op monitor globals.
      const factory = new Function('globalThis', `${out}\n;return f;`);
      // Provide explicit stub monitor globals rather than relying on the preamble's
      // `|| function(){}` fallback. This keeps the test pinned to the strict-mode
      // assertion (the ReferenceError must come from the demotion check, not from a
      // missing-global TypeError) and stays robust if the preamble pattern changes.
      const g: any = {
        __serviceeventsMonitorEnter: () => null,
        __serviceeventsMonitorExit: () => undefined,
        __serviceeventsMonitorException: () => undefined,
      };
      const f = factory(g);
      expect(() => f()).toThrow(ReferenceError);
    });
  });
});
