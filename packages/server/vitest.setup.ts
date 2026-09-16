// ════════════════════════════════════════
// EVERY TEST WORKER GETS ITS OWN HOME, AND CANNOT REACH THE REAL ONE.
//
// Runs inside each worker process, before that worker imports a single line of the
// code under test — which matters, because most `~/.dojo` paths in this server are
// module-level constants frozen at first import.
//
// ── THE GRANULARITY, AND WHY IT IS PER PROCESS ──
// One home per worker PROCESS, keyed on pid. The thing that has to be isolated is
// better-sqlite3: it is a synchronous, in-process library, and the damage shape is
// N operating-system processes opening and migrating the SAME `dojo.db` at the same
// time (369 concurrent migration boots is exactly what the real home saw). Test
// files inside one worker run one after another and cannot collide that way, so the
// process boundary is the honest boundary — a finer one would claim an isolation the
// pool model does not actually provide.
//
// ── THE THREE LAYERS ──
//   1. DOJO_HOME      — what `src/home.ts` reads. The whole server resolves through it.
//   2. HOME/USERPROFILE — the belt. Even a path that bypasses `homeDir()` and calls
//                       `os.homedir()` itself lands in the scratch home, not the
//                       developer's account.
//   3. os.homedir()   — patched to THROW. Layer 2 alone would let a bypass pass
//                       silently forever; this is the braces, and it is how a new
//                       `os.homedir()` call site announces itself the first time it
//                       runs. Its static twin is `src/__tests__/tests-stay-home.test.ts`.
// ════════════════════════════════════════

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Read FIRST, before HOME is redirected: `os.homedir()` answers from $HOME on POSIX,
// so after the redirect below there is no way left to ask what the real one was.
const realHome = os.homedir();

const runRoot =
  process.env.DOJO_TEST_HOME_ROOT && process.env.DOJO_TEST_HOME_ROOT !== ''
    ? process.env.DOJO_TEST_HOME_ROOT
    : path.join(os.tmpdir(), 'dojo-test-homes', 'orphan-run');

const workerId = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? 'x';
const home = path.join(runRoot, `w${workerId}-${process.pid}`);

fs.mkdirSync(path.join(home, '.dojo'), { recursive: true });

process.env.DOJO_HOME = home;
process.env.HOME = home;
process.env.USERPROFILE = home;

// ── Layer 3 ──
// `os.homedir` is patched on the CommonJS exports object that every
// `import os from 'node:os'` in this tree resolves to, so a direct call from OUR OWN
// code is loud instead of silently correct-by-luck. The real function stays reachable
// for the one test that has to assert production behaviour.
//
// Third-party callers get the scratch home instead of a throw: `playwright-core`
// resolves `os.homedir()` at module load, and several packages cache under `~`. They
// are not the defect this guards — layer 2 already makes their home the scratch one,
// and throwing at them would only make the guard unusable. The rule enforced here is
// the one we can actually keep: nothing under `packages/server` calls `os.homedir()`
// except `src/home.ts`, which is also asserted statically, without running anything,
// in `src/__tests__/tests-stay-home.test.ts`.
const realHomedir = (): string => realHome;
(globalThis as Record<string, unknown>).__dojoRealHomedir = realHomedir;

/**
 *  'sanctioned' — src/home.ts, the ONE place allowed to ask. It only gets this far
 *                 when DOJO_HOME is unset and the run is not flagged as a test, which
 *                 is the production path one test drives on purpose.
 *  'third-party'  — node_modules. Not the defect this guards; layer 2 covers it.
 *  'banned'       — anything else under packages/server.
 */
function classifyCaller(): 'sanctioned' | 'third-party' | 'banned' {
  const frames = (new Error().stack ?? '').split('\n').slice(2);
  const caller = frames.find((f) => !f.includes('vitest.setup.ts'));
  if (caller === undefined) return 'third-party';
  if (/[/\\]src[/\\]home\.ts/.test(caller)) return 'sanctioned';
  if (!caller.includes('/packages/server/') || caller.includes('/node_modules/')) return 'third-party';
  return 'banned';
}

Object.defineProperty(os, 'homedir', {
  configurable: true,
  writable: true,
  value: function patchedHomedir(): string {
    const who = classifyCaller();
    if (who === 'sanctioned') return realHomedir();
    if (who === 'third-party') return home;
    throw new Error(
      'REAL-HOME TRIPWIRE: os.homedir() was called directly during a test run.\n' +
        '  Nothing in packages/server may call it except src/home.ts. Use homeDir() from\n' +
        "  '../home.js' instead — it honours DOJO_HOME, which is how tests get a throwaway\n" +
        "  home instead of writing into the developer's real ~/.dojo.\n" +
        `  This worker's home is ${home}.\n` +
        '  (If you genuinely need the real value in a test: globalThis.__dojoRealHomedir().)',
    );
  },
});
