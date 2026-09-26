// ════════════════════════════════════════════════════════════════════════════════════════
// THE PLATFORM CAN READ ITS OWN VERSION, UNDER THE RUNTIME IT ACTUALLY RUNS (T8 LIVE, D-A).
//
// ── THE DEFECT, AND WHY NO EXISTING CLAUSE COULD SEE IT ──
// `getCurrentVersion()`'s dev-mode fallback opened with `let dir = __dirname`, inside a bare
// `try { … } catch { }`. `packages/server` is `"type": "module"`; a `.ts` file in an ESM
// package has no `__dirname` under `tsx`, and a `.js` file in one has none under plain `node`
// over `dist/` either. So the line threw `ReferenceError`, the empty `catch` swallowed it, and
// the function answered the literal `'0.0.0'`.
//
// **THE SUITE WAS STRUCTURALLY BLIND TO IT.** vite-node wraps every module it loads in a
// function whose parameters INCLUDE `__dirname`, so inside vitest the broken line worked. The
// suite read `3.1.28`; the running dev box read `0.0.0`. Measured live on 2026-09-26: issues #3
// and #4 on the scratch tracker are stamped `**Filed from Agent Dojo v0.0.0**`, both report
// signatures were keyed on `0.0.0`, and every export prefill asked for the label `v0.0.0`.
//
// So the first clause here does not run in this process. It spawns the repo's real `tsx` on a
// child fixture and reads the answer off its stdout, with `typeof __dirname` printed beside it
// as the control: if that control ever reads anything but `undefined`, the child is not under
// an ESM loader and its agreement proves nothing. **Re-plant `__dirname` in `update.ts` and
// clause 1 goes red; vite-node's injection cannot reach a separate process.**
//
// ── AND THE OTHER HALF: A VERSION THAT CANNOT BE READ MUST NOT LOOK LIKE A VERSION ──
// `'0.0.0'` is valid semver, and that is what made it expensive. Three separate honest-absence
// mechanisms were already in the tree and `'0.0.0'` walked past all three: `reportVersion()`
// returns null only for a non-version, `issueLabelsFor()` drops the version label only for a
// non-version, and the telemetry whitelist's `platform.version` pattern admits only a real
// semver. A sentinel re-arms all three at once, and clauses 3 and 4 hold that — a future
// `return '0.0.0'` is not merely wrong, it is red.
//
// ── THE ARMS, EACH WITH ITS CONTROL ──
//   1. the repo, under the real runtime   → the version in the root `package.json`, exactly.
//   2. the source                          → derived from `import.meta.url`; no `__dirname`.
//   3. an installed platform that declares no version → the SENTINEL, and a logged reason.
//      (positive control: one that DOES declare a version → that version.)
//   4. the sentinel is refused by all three of the tree's honest-absence mechanisms.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION_UNREADABLE } from '../update.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `packages/server/src/gateway/routes/__tests__` → the repo root. */
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..', '..', '..');
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const CHILD = path.join(HERE, 'the-version-is-read-the-way-an-esm-module-must-read-it-child.ts');
const UPDATE_TS = path.resolve(HERE, '..', 'update.ts');

/** The one authority this file compares against: the repo's own root `package.json`. */
const rootPackage = (): { name: string; version: string } =>
  JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { name: string; version: string };

let home = '';

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-version-esm-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

interface ChildAnswer { version: string; runtimeDirname: string; out: string }

/**
 * Run the child under the repo's real `tsx`.
 *
 * `VITEST` is deliberately DELETED from the child's environment: the point of this process is
 * to be the runtime the owner's box runs, not a test runner, and `home.ts`'s real-home tripwire
 * keys on that variable. `DOJO_HOME` and `HOME` both point at the arm's scratch tree, so
 * `PLATFORM_DIR` is whatever the arm staged and the owner's `~/.dojo` is never opened.
 */
function runChild(): ChildAnswer {
  const env = { ...process.env, HOME: home, DOJO_HOME: home };
  delete env.VITEST;
  delete env.NODE_ENV;
  const r = spawnSync(TSX, [CHILD], { env, encoding: 'utf8', timeout: 60_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  expect(r.status, `the child did not exit cleanly (status ${String(r.status)}, signal `
    + `${String(r.signal)}):\n${out}`).toBe(0);
  const grab = (key: string): string => {
    const m = out.match(new RegExp(`^${key}=(.*)$`, 'm'));
    expect(m, `the child printed no ${key} line:\n${out}`).toBeTruthy();
    return m![1].trim();
  };
  return { version: grab('VERSION'), runtimeDirname: grab('RUNTIME_DIRNAME'), out };
}

/** Stage `<home>/.dojo/platform/package.json` with the given raw text. */
function stageInstalledPlatform(raw: string): void {
  const dir = path.join(home, '.dojo', 'platform');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), raw);
}

/** Everything the child's logger flushed on its way out. The durable sink, read after death. */
function childLog(): string {
  const f = path.join(home, '.dojo', 'logs', 'dojo.log');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
}

// ── 1. THE REAL RUNTIME ──────────────────────────────────────────────────────────────────

describe('under the runtime the dev box actually runs', () => {
  it('reads the version in the repo root package.json, and NOT 0.0.0', () => {
    const { version, runtimeDirname, out } = runChild();

    // THE CONTROL, FIRST. If this runtime injected `__dirname`, the clause below would pass
    // over the very defect it exists for — which is exactly what vitest did for one release.
    expect(runtimeDirname, 'the child is not running as an ESM module, so it cannot tell us '
      + `anything about the ESM bug:\n${out}`).toBe('undefined');

    const pkg = rootPackage();
    expect(pkg.name, 'the repo root package.json is not the platform manifest this test '
      + 'compares against').toBe('dojo-platform');
    expect(version, `the platform answered ${version} under its own runtime while its manifest `
      + `says ${pkg.version}`).toBe(pkg.version);
    expect(version, 'the swallowed-ReferenceError fallback is back').not.toBe('0.0.0');
  });

  it('answers the SAME version the suite sees — the two runtimes may not disagree', async () => {
    // The property the release blocker violated, stated directly. Not "the child is right" and
    // not "the suite is right": that they AGREE. One of them was wrong for a whole release and
    // nothing compared them.
    const { getCurrentVersion } = await import('../update.js');
    expect(runChild().version, 'the suite and the real runtime read different versions')
      .toBe(getCurrentVersion());
  });
});

// ── 2. THE SOURCE ────────────────────────────────────────────────────────────────────────

/**
 * The file's CODE: comments, string literals and template literals blanked out, newlines kept.
 *
 * Written properly rather than approximated because a census is only as good as its reader, and
 * both cheap readings are wrong here. Cutting each line at its first `//` eats `foo(__dirname)`
 * on any line that also carries `'https://…'` — and update.ts carries several — which is a
 * census with a FALSE NEGATIVE, worse than no census. Classifying whole LINES as comments
 * misses a closing block comment followed by real code on the same line. The module header has
 * to be free to NAME the defect it warns about, so the reader has to know prose from code.
 */
function codeOnly(src: string): string {
  type Mode = 'code' | 'line' | 'block' | "'" | '"' | '`';
  let out = '';
  let mode: Mode = 'code';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '/') { mode = 'line'; i += 2; continue; }
      if (c === '/' && d === '*') { mode = 'block'; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') { mode = c; out += ' '; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += '\n'; }
      i += 1; continue;
    }
    if (mode === 'block') {
      if (c === '*' && d === '/') { mode = 'code'; i += 2; continue; }
      if (c === '\n') out += '\n';
      i += 1; continue;
    }
    // inside a string or template: skip the body, honouring backslash escapes
    if (c === '\\') { i += 2; continue; }
    if (c === mode) { mode = 'code'; i += 1; continue; }
    if (c === '\n') out += '\n';
    i += 1; continue;
  }
  return out;
}

describe('the module derives its own directory the only way an ESM module can', () => {
  it('reads it from import.meta.url, and no CODE line names __dirname', () => {
    const src = fs.readFileSync(UPDATE_TS, 'utf8');
    const code = codeOnly(src);

    // ── THE READER IS CHECKED FIRST, BOTH WAYS. A stripper that ate the file would pass the
    // negative below vacuously, and one that stripped nothing would fail it on the header's
    // own prose. Neither can hide here.
    expect(code, 'the reader stripped away the code it is supposed to be reading')
      .toContain('export function getCurrentVersion');
    expect(code, 'the reader left comment prose in what it calls code')
      .not.toContain('vite-node wraps every module');

    // Non-vacuity for the negative: the ESM-correct derivation is really here, in CODE.
    expect(code, 'update.ts no longer derives its directory from import.meta.url')
      .toMatch(/fileURLToPath\(\s*import\.meta\.url\s*\)/);

    // And no code line names it — not as a read, and not as a locally-declared shim either: a
    // file that declares `const __dirname = …` reads as though the global existed, and invites
    // the next author to reach for it somewhere the declaration does not cover.
    expect(code, 'update.ts names __dirname in code again; there is no such binding in an ESM '
      + 'module, and reading one throws').not.toContain('__dirname');
  });
});

// ── 3. NOTHING IS SWALLOWED, AND NOTHING PRETENDS TO BE A VERSION ────────────────────────

describe('a version that cannot be read is said so, in the real runtime', () => {
  it('an installed manifest that declares no version answers the SENTINEL, not 0.0.0', () => {
    stageInstalledPlatform(JSON.stringify({ name: 'dojo-platform' }));
    const { version, out } = runChild();
    expect(version, `the old \`pkg.version ?? '0.0.0'\` is back:\n${out}`).toBe(VERSION_UNREADABLE);
    // AND THE REASON IS ON THE RECORD. This is the half the bare `catch` used to eat: the log
    // is read off the child's own durable sink after it has exited and flushed.
    const log = childLog();
    expect(log, `nothing was logged about a version the platform could not read:\n${out}`)
      .toContain('cannot read its own version');
    expect(log, 'the log does not say WHICH manifest could not answer').toContain('declares no version');
  });

  it('an installed manifest that will not parse answers the SENTINEL and names the failure', () => {
    stageInstalledPlatform('{ this is not json');
    const { version, out } = runChild();
    expect(version, `a corrupt install read as a healthy one:\n${out}`).toBe(VERSION_UNREADABLE);
    expect(childLog(), 'a manifest that would not parse was swallowed')
      .toContain('could not be read');
  });

  it('...and the POSITIVE CONTROL: an installed manifest that DOES declare one is believed', () => {
    // Without this, every arm above would pass on a function that returned the sentinel
    // unconditionally, and "the installed platform is read first" would be held by nothing.
    stageInstalledPlatform(JSON.stringify({ name: 'dojo-platform', version: '9.9.9' }));
    const { version } = runChild();
    expect(version, 'the installed platform manifest is no longer the first authority').toBe('9.9.9');
    expect(version).not.toBe(rootPackage().version);
  });
});

// ── 4. THE SENTINEL IS REFUSED BY EVERY HONEST-ABSENCE MECHANISM IN THE TREE ─────────────

describe('the sentinel cannot be mistaken for a version anywhere it travels', () => {
  it('is not semver, so it takes no label, no header stamp and no trailer', async () => {
    const { issueLabelsFor, REPORT_ISSUE_LABELS } = await import('../../../report/issue-body.js');
    const { TELEMETRY_WHITELIST } = await import('../../../report/telemetry-whitelist.js');

    // (a) no GitHub label. `'0.0.0'` asked the public tracker for a label called `v0.0.0`.
    expect(issueLabelsFor(VERSION_UNREADABLE), 'the platform would ask a public tracker for a '
      + `label called v${VERSION_UNREADABLE}`).toEqual([...REPORT_ISSUE_LABELS]);
    // …and the control, so this is about the SENTINEL and not about the function being broken.
    expect(issueLabelsFor('3.1.28')).toEqual([...REPORT_ISSUE_LABELS, 'v3.1.28']);

    // (b) the telemetry whitelist refuses it, so the attachment carries `<unrecognised>`.
    const field = TELEMETRY_WHITELIST.find(f => f.path === 'platform.version');
    expect(field?.pattern, 'platform.version lost the pattern this clause reads').toBeTruthy();
    expect(field!.pattern!.test(VERSION_UNREADABLE), 'the telemetry whitelist would publish the '
      + 'sentinel as though it were a version').toBe(false);
    expect(field!.pattern!.test('3.1.28')).toBe(true);

    // (c) the one thing `'0.0.0'` was: valid semver. That is the whole defect, in one line.
    expect(field!.pattern!.test('0.0.0'), 'this is why a plausible-looking fallback was '
      + 'expensive — every mechanism above admits it').toBe(true);
  });
});
