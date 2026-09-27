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
  it('provides the five APIs jsdom would have needed hand-written stubs for', () => {
    // matchMedia — 2 call sites (theme + reduced-motion)
    expect(typeof window.matchMedia).toBe('function');
    expect(typeof window.matchMedia('(prefers-color-scheme: dark)').matches).toBe('boolean');
    // ResizeObserver — 2 call sites
    expect(typeof globalThis.ResizeObserver).toBe('function');
    // IntersectionObserver — 1 call site
    expect(typeof globalThis.IntersectionObserver).toBe('function');
    // Element.scrollIntoView — 2 call sites (chat autoscroll)
    expect(typeof document.createElement('div').scrollIntoView).toBe('function');
    // navigator.clipboard — 7 call sites (copy buttons)
    expect(navigator.clipboard).toBeDefined();
  });

  it('provides the storage, animation and socket primitives the app boots on', () => {
    expect(typeof localStorage.getItem).toBe('function');   // 25 call sites
    expect(typeof globalThis.WebSocket).toBe('function');   // 29 call sites
    expect(typeof requestAnimationFrame).toBe('function');  // 6 call sites
    expect(typeof URL.createObjectURL).toBe('function');    // 5 call sites
  });

  it('refuses the network, so no component test can pass because a server was up', () => {
    expect(() => fetch('/api/anything')).toThrow(/NETWORK TRIPWIRE/);
  });

  it('starts every test logged out, which is why no socket is opened', () => {
    expect(localStorage.getItem('dojo_token')).toBeNull();
  });

  it('answers getContext with null — the one thing no headless DOM can do', () => {
    // The orb asks for WebGL. A browser with no GPU context answers null, and the
    // engine has to survive it; the stub asserts that path instead of faking a GPU.
    expect(document.createElement('canvas').getContext('webgl')).toBeNull();
  });
});
