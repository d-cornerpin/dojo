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

// ════════════════════════════════════════
// NO TEST MAY START A REAL AGENT CLI, AND NO WORKER CARRIES A REAL CREDENTIAL (t140 round 2).
//
// MEASURED: a per-file mock of `@anthropic-ai/claude-agent-sdk` was intermittently bypassed —
// one dynamic import inside the production transport received the REAL package, which spawned
// the real Claude CLI. It answered "Not logged in" only because HOME is redirected above; the
// worker still carried this session's CLAUDE_CODE_* variables into that child, and on a box with
// an API key or a login the CLI can find, the call would have reached the network.
//
// So three nets, each sufficient on its own for what it covers:
//   1. ENV SCRUB — provider credentials and the coding-agent session variables are removed from
//      every worker before any code under test runs. A child that does start inherits nothing.
//   2. THE PACKAGE, MOCKED SUITE-WIDE TO THROW BY NAME. A file that needs a scripted transport
//      mocks the in-tree `providers/anthropic-sdk.js` instead (t140's two files and the two
//      agent-sdk transport files do), so nothing legitimate needs the package.
//   3. THE SPAWN DOOR — even the REAL package (vi.importActual, or a mock that misses) cannot
//      start the CLI: child_process's spawning functions refuse any command line that names the
//      Claude CLI or the Agent SDK, loudly. `syncBuiltinESMExports` carries the patch to ESM
//      named imports, which is how the SDK imports `spawn`.
// `src/__tests__/t140-no-test-reaches-a-real-agent-cli.test.ts` plants each attempt and asserts
// it fails loudly.
// ════════════════════════════════════════

import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { vi } from 'vitest';

const SCRUBBED_ENV = /^(CLAUDE_CODE_|CLAUDECODE$|ANTHROPIC_|OPENAI_|OPENROUTER_|DEEPSEEK_|GEMINI_|GOOGLE_API_KEY$|GOOGLE_APPLICATION_CREDENTIALS$|MISTRAL_|GROQ_|XAI_|AWS_ACCESS_KEY_ID$|AWS_SECRET_ACCESS_KEY$|AWS_SESSION_TOKEN$)/;
for (const key of Object.keys(process.env)) {
  if (SCRUBBED_ENV.test(key)) delete process.env[key];
}

const AGENT_CLI_NET_MESSAGE = 'TEST NET: a test tried to start the real Claude CLI / Agent SDK. Script the in-tree transport (providers/anthropic-sdk.js) instead.';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => { throw new Error(AGENT_CLI_NET_MESSAGE); },
}));

const AGENT_CLI = /claude-agent-sdk|claude-code|(^|[\\/\s])claude(\.exe|\.cmd)?(\s|$)/i;
function refuseAgentCli<T extends (...args: never[]) => unknown>(name: string, real: T): T {
  return function guarded(this: unknown, ...args: unknown[]) {
    const line = args.flatMap((a) => (Array.isArray(a) ? a : [a]))
      .filter((a): a is string => typeof a === 'string').join(' ');
    if (AGENT_CLI.test(line)) throw new Error(`${AGENT_CLI_NET_MESSAGE} (child_process.${name}: ${line.slice(0, 120)})`);
    return (real as unknown as (...a: unknown[]) => unknown).apply(this, args);
  } as unknown as T;
}
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) {
  (childProcess as unknown as Record<string, unknown>)[name] = refuseAgentCli(name, childProcess[name] as never);
}
syncBuiltinESMExports();
