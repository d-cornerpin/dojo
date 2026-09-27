// ════════════════════════════════════════════════════════════════════════════
// THE DASHBOARD'S TEST RUNNER (BACKLOG line 54).
//
// ── WHY THIS FILE EXISTS ──
// Until now `packages/dashboard` had NO runner. `tsc && vite build` is
// type-checking, not behaviour, and five separate reports said so in the same
// words while writing their own rules down as prose:
//
//   DOJO-REPORT T5 §2b  — "requires a DOM runner" · "the one worth a DOM runner
//                          if the house ever gets one"
//   DOJO-REPORT T6 §7   — "that the brief's five fields actually reach the DOM
//                          unescaped-but-uninterpreted … nothing observes the pixels"
//   DOJO-REPORT T7 §6   — "the card's JSX wiring … has no DOM runner"
//   BACKLOG lane 4      — "Forcing the fast path unconditionally still survives,
//                          and will until `packages/dashboard` has a test runner"
//
// A rule that only a comment holds is a rule the next edit deletes for free.
//
// ── WHY happy-dom AND NOT jsdom — MEASURED, NOT PREFERRED ──
// Census of the browser APIs this dashboard actually touches (121 source files):
// `matchMedia` 2 · `ResizeObserver` 2 · `IntersectionObserver` 1 ·
// `scrollIntoView` 2 · `navigator.clipboard` 7 · `localStorage` 25 ·
// `WebSocket` 29 · `canvas.getContext` 1 (the orb, WebGL).
//
// happy-dom implements the first five natively; jsdom implements NONE of them
// and each would have to be hand-stubbed in this repo's setup file — five stubs
// whose fidelity nobody would ever check. The single `getContext` call site is
// WebGL, which jsdom cannot do either (its optional `canvas` package is 2D), so
// jsdom's one genuine advantage buys this tree nothing. happy-dom is also
// ESM-native and starts in a fraction of the time, which matters for a suite
// that is meant to join the release path rather than be run when someone
// remembers. `vitest.setup.ts` records what still had to be stubbed — that list
// IS the ongoing argument, and if it ever grows past a handful, revisit this.
// ════════════════════════════════════════════════════════════════════════════

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The dashboard's `vite.config.ts` is a DEV SERVER config (proxy, HMR socket
  // suppression, LAN binding) and none of it applies to a test run, so this file
  // stands alone rather than merging it. JSX is transformed by esbuild using the
  // same `react-jsx` mode `tsconfig.json` declares.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'happy-dom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Same argument as `packages/server/vitest.config.ts`: a per-test timeout is
    // a HANG DETECTOR, not a performance assertion. A component test that mounts
    // a page imports a real module graph on a cold cache.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
