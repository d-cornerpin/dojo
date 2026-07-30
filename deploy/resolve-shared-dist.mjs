// Node resolve hook for `deploy/check-tool-conformance.mjs` ONLY.
//
// WHY THIS EXISTS (SHIP-PREP, 2026-07-30). The conformance gate imports BUILT modules out of
// `packages/server/dist`. Those modules carry bare `@dojo/shared` specifiers, and bare-specifier
// resolution walks up to the repo root's `node_modules/@dojo/shared`, which is the workspace
// symlink to `packages/shared`, whose `package.json` deliberately points
//
//     "main": "./src/index.ts"
//
// at TypeScript SOURCE so the dev server (`tsx watch`) needs no build step. Plain Node cannot
// load that file, and it cannot map its `export … from './types.js'` onto `types.ts`, so the
// import throws `Cannot find module …/packages/shared/src/types.js` and the gate exits 1 —
// reporting "a tool-name list drifted from the real tool surface" when nothing has drifted.
//
// `deploy/build-package.sh:63-67` records the same fact and solves it for the shipped artifact
// by REWRITING the staged copy's `main` to `./dist/index.js`. That is why the packaged build
// smoke-boots while the repo-local `dist` does not. Staging alone does not help the gate,
// because a staged file inside the repo still resolves `@dojo/shared` up to the same symlink.
//
// So the resolution is corrected HERE, for one script, instead of changing
// `packages/shared/package.json` — which would make the dev server load a stale `dist` and is
// the exact ergonomic the comment in build-package.sh exists to protect.
//
// Nothing in the product's module graph is affected: this hook is registered by the gate
// script and nowhere else.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHARED_DIST = path.resolve(HERE, '..', 'packages', 'shared', 'dist');

export async function resolve(specifier, context, next) {
  if (specifier === '@dojo/shared') {
    return {
      url: pathToFileURL(path.join(SHARED_DIST, 'index.js')).href,
      shortCircuit: true,
    };
  }
  if (specifier.startsWith('@dojo/shared/')) {
    const rest = specifier.slice('@dojo/shared/'.length).replace(/\.js$/, '');
    return {
      url: pathToFileURL(path.join(SHARED_DIST, `${rest}.js`)).href,
      shortCircuit: true,
    };
  }
  return next(specifier, context);
}
