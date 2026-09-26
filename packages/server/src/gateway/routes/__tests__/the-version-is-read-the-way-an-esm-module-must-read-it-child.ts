// THE CHILD. Run by `the-version-is-read-the-way-an-esm-module-must-read-it.test.ts`
// through the repo's real `tsx`, never by the suite directly — which is the whole point.
//
// ── WHY THIS PROCESS EXISTS ──
// `getCurrentVersion()` read `__dirname`. `packages/server` is `"type": "module"`, so under
// the runtime the dev box actually uses there IS no `__dirname` and reading one throws
// `ReferenceError`. A bare `catch` swallowed it and the function answered `'0.0.0'`.
//
// VITEST COULD NOT SEE THIS. vite-node wraps every module in a function that INJECTS
// `__dirname`, so inside the suite the broken line worked and the suite read `3.1.28` while
// the running dev box read `0.0.0` — every posted issue, every signature and every export
// prefill stamped with a version that was not the platform's. An instrument that cannot see
// the defect it exists for is worth nothing, so the resolution is driven HERE, in a separate
// process, under the real loader, where nothing injects anything.
//
// It prints machine-readable lines on stdout and the parent parses them:
//
//   RUNTIME_DIRNAME=<typeof __dirname>   the control. Must be `undefined`, or this child is
//                                        not running under an ESM loader and proves nothing.
//   VERSION=<getCurrentVersion()>        the measurement.
//
// `typeof` is used deliberately: it is the one operator that does not throw on an undeclared
// identifier, so the control can be taken without ending the process.
//
// argv[2] selects the arm; every arm's home is the temp `DOJO_HOME` the parent passes, so
// `PLATFORM_DIR` is whatever that arm staged there and the owner's `~/.dojo` is never read.

import { getCurrentVersion } from '../update.js';

console.log(`RUNTIME_DIRNAME=${typeof __dirname}`);
console.log(`VERSION=${getCurrentVersion()}`);
