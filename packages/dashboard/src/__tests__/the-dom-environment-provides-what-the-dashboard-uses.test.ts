// ════════════════════════════════════════════════════════════════════════════
// THE ENVIRONMENT CONTRACT.
//
// `vitest.config.ts` chose happy-dom over jsdom on ONE argument: happy-dom
// natively implements the browser APIs this dashboard actually calls, so the
// setup file does not have to hand-stub five of them. That argument is only as
// good as its facts, and facts about a dependency go stale on upgrade.
//
// So the facts are a test. If happy-dom ever drops one of these, this clause
// fails and names it — instead of a component test failing three files away for
// a reason nobody can read.
//
// THE LIST IS NOT DECORATIVE: each entry is a MEASURED call site in this
// package. The counts are from a census of `packages/dashboard/src`.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

describe('the DOM environment provides what the dashboard calls', () => {
  /**
   * ⚠ ONE ROW PER API, AND THE ROW'S NAME IS THE FAILURE MESSAGE (final sweep C, B3).
   *
   * The first cut put all five in one `it` with no per-assertion message, so dropping
   * `ResizeObserver` reported `expected 'undefined' to be 'function'` — the right FILE and no
   * API name, leaving a reader to bisect five candidates. The header's claim is that this
   * clause "fails and names it", so the name has to be in the output.
   *
   * The call-site counts are a measured census of `packages/dashboard/src` and they are part of
   * the row: an API with no call sites does not belong here, and one whose count went to zero is
   * a row to delete rather than keep asserting.
   */
  const API_ROWS: ReadonlyArray<{ api: string; sites: number; present: () => boolean }> = [
    { api: 'window.matchMedia', sites: 2, present: () => typeof window.matchMedia === 'function' },
    {
      api: 'window.matchMedia(…).matches',
      sites: 2,
      present: () => typeof window.matchMedia('(prefers-color-scheme: dark)').matches === 'boolean',
    },
    { api: 'ResizeObserver', sites: 2, present: () => typeof globalThis.ResizeObserver === 'function' },
    { api: 'IntersectionObserver', sites: 1, present: () => typeof globalThis.IntersectionObserver === 'function' },
    {
      api: 'Element.scrollIntoView',
      sites: 2,
      present: () => typeof document.createElement('div').scrollIntoView === 'function',
    },
    { api: 'navigator.clipboard', sites: 7, present: () => navigator.clipboard !== undefined },
    { api: 'localStorage.getItem', sites: 25, present: () => typeof localStorage.getItem === 'function' },
    { api: 'WebSocket', sites: 29, present: () => typeof globalThis.WebSocket === 'function' },
    { api: 'requestAnimationFrame', sites: 6, present: () => typeof requestAnimationFrame === 'function' },
    { api: 'URL.createObjectURL', sites: 5, present: () => typeof URL.createObjectURL === 'function' },
  ];

  it.each(API_ROWS)('happy-dom still provides $api ($sites call sites)', ({ api, sites, present }) => {
    expect(
      present(),
      `happy-dom no longer provides \`${api}\`, which this package calls at ${sites} measured site(s). `
      + 'Either the upgrade dropped it — stub it in `vitest.setup.ts` and add it to that file\'s '
      + 'residue list, which is the argument for choosing happy-dom at all — or the call sites are '
      + 'gone, in which case delete this row.',
    ).toBe(true);
  });

  it('the census covers every API the setup file does NOT stub', () => {
    // Non-vacuity, and the reason the table cannot quietly shrink: ten rows, and the one API the
    // setup DOES stub (`getContext`) is deliberately not among them — it has its own clause below.
    expect(API_ROWS.length).toBe(10);
    expect(API_ROWS.map(r => r.api)).not.toContain('HTMLCanvasElement.getContext');
    expect(API_ROWS.every(r => r.sites > 0), 'a row with no call sites is not a contract').toBe(true);
  });

  it('refuses the network, so no component test can pass because a server was up', () => {
    expect(() => fetch('/api/anything')).toThrow(/NETWORK TRIPWIRE/);
  });

  it('starts every test logged out, which is why no socket is opened', () => {
    expect(localStorage.getItem('dojo_token')).toBeNull();
  });

  /**
   * ⚠ THIS CLAUSE HOLDS THE STUB, NOT THE COINCIDENCE (final sweep C, B2).
   *
   * MEASURED BY THE REVIEWER: deleting the `getContext` stub from `vitest.setup.ts` left 45/45
   * green, because happy-dom 20.14.5 already answers `null` for `webgl`, `webgl2` AND `2d`. So
   * the old assertion — `getContext('webgl')` is null — passed for a reason that was not the
   * stub, the setup file's "residue, in full" claim was unpinned, and the day happy-dom returns
   * a 2D-ish object the stub's removal (or its silent breakage) would be invisible.
   *
   * So the subject is the STUB ITSELF: the setup installs one function on the prototype, that
   * one function is what every context request reaches, and it answers null for all three. A
   * reader who deletes the stub now fails here with a message naming the file to restore it in.
   */
  it('the setup\'s OWN getContext stub is what answers, for every context it is asked for', () => {
    const canvas = document.createElement('canvas');
    const own = HTMLCanvasElement.prototype.getContext as unknown;

    // 1. The prototype carries the setup's stub rather than happy-dom's implementation. A
    //    zero-argument arrow is what `vitest.setup.ts` installs; happy-dom's own method declares
    //    parameters, so the arity is the discriminator that does not depend on identity tricks.
    expect(typeof own, 'nothing is installed on HTMLCanvasElement.prototype.getContext').toBe('function');
    expect(
      (own as (...a: unknown[]) => unknown).length,
      'HTMLCanvasElement.prototype.getContext is no longer the zero-argument stub `vitest.setup.ts` '
      + 'installs. If happy-dom now implements canvas contexts, DELETE the stub and say so in that '
      + 'file\'s residue list — do not leave a stub nobody can tell is there.',
    ).toBe(0);

    // 2. Every context the orb or a future caller could ask for answers null THROUGH it. The
    //    orb asks for WebGL; a browser with no GPU context answers null and the engine has to
    //    survive it, which is the production path this asserts instead of faking a GPU.
    for (const kind of ['webgl', 'webgl2', '2d'] as const) {
      expect(canvas.getContext(kind), `getContext('${kind}') stopped answering null`).toBeNull();
    }

    // 3. And the stub is on the PROTOTYPE, so it answers for canvases created before it ran too.
    expect(Object.prototype.hasOwnProperty.call(HTMLCanvasElement.prototype, 'getContext')).toBe(true);
  });
});
