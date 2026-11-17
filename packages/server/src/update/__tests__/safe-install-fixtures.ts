// Shared fixtures for the t197 safe-install suites. Not a test file: the trees, the fake `npm`
// and the tree hash every fault-injection clause compares with.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../../../../..');
export const ROLLBACK_SH = path.join(REPO_ROOT, 'deploy/scripts/rollback.sh');
// The repo's tsx loaded INTO one node process (not the `tsx` launcher, which runs the code in a
// child): a SIGKILL at a step must be the death of the very process the test observes.
const TSX_LOADER = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs');
const DRIVER = path.join(HERE, 'safe-install-driver.ts');

/** A tree that looks like an installed platform of `version`. `native` adds a loadable database module. */
export function makeTree(dir: string, version: string, opts: { native?: boolean } = {}): string {
  fs.mkdirSync(path.join(dir, 'packages', 'server', 'dist'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dojo-platform', version }));
  fs.writeFileSync(path.join(dir, 'packages', 'server', 'package.json'), JSON.stringify({ name: '@dojo/server', type: 'module' }));
  fs.writeFileSync(path.join(dir, 'packages', 'server', 'dist', 'index.js'), `// build ${version}\n`);
  // A file only this version has, so a MIXED tree is visible as both sets at once.
  fs.writeFileSync(path.join(dir, 'templates', `only-in-${version}.md`), version);
  if (opts.native) {
    const mod = path.join(dir, 'node_modules', 'better-sqlite3');
    fs.mkdirSync(mod, { recursive: true });
    fs.writeFileSync(path.join(mod, 'package.json'), JSON.stringify({ name: 'better-sqlite3', main: 'index.js' }));
    fs.writeFileSync(path.join(mod, 'index.js'),
      'module.exports = class { prepare() { return { get() { return { x: 1 }; } }; } close() {} };\n');
  }
  return dir;
}

/** Content hash of a whole tree (paths + bytes), or null when it is not there. */
export function treeHash(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const h = crypto.createHash('sha256');
  const walk = (d: string): void => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p);
      else { h.update(path.relative(dir, p)); h.update(fs.readFileSync(p)); }
    }
  };
  walk(dir);
  return h.digest('hex');
}

export interface Box { home: string; dojo: string; bin: string; platform: string }

/** A scratch HOME with a stub launchctl and a fake npm on PATH. Nothing real is touched. */
export function makeBox(prefix: string): Box {
  const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), prefix));
  const dojo = path.join(home, '.dojo');
  const bin = path.join(home, 'bin');
  fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
  fs.mkdirSync(dojo, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  // launchd's list follows load and unload (both start loaded), so restore-db.sh can see a stopped platform.
  fs.writeFileSync(path.join(bin, 'launchctl'), `#!/bin/sh\ncase "$1" in list) [ -f "${home}/up" ] && printf '1\\t0\\tcom.dojo.platform\\n-\\t0\\tcom.dojo.watchdog\\n'; exit 0;; unload) rm -f "${home}/up";; load) touch "${home}/up";; esac\necho "$@" >> "${home}/launchctl.log"\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(home, 'up'), '');
  // The fake npm. NPM_MODE: ok | fail | enospc | nonative | kill (SIGKILLs the installer mid-run).
  fs.writeFileSync(path.join(bin, 'npm'), [
    '#!/bin/sh',
    'mkdir -p node_modules/.half-written',
    'case "$NPM_MODE" in',
    '  fail) echo "npm ERR! network request failed" >&2; exit 1 ;;',
    '  enospc) echo "npm ERR! ENOSPC: no space left on device, write" >&2; exit 1 ;;',
    '  kill) kill -9 "$INSTALLER_PID"; sleep 5; exit 1 ;;',
    '  nonative) rm -rf node_modules/better-sqlite3 ;;',
    'esac',
    'rmdir node_modules/.half-written',
    'echo installed > node_modules/.npm-ran',
    'exit 0',
  ].join('\n') + '\n', { mode: 0o755 });
  return { home, dojo, bin, platform: path.join(dojo, 'platform') };
}

export interface DriverRun { status: number | null; signal: NodeJS.Signals | null; out: string; result: unknown }

/** Run the real installer in a CHILD process, so a SIGKILL at a step is a real crash. */
export function runInstaller(box: Box, env: Record<string, string>): DriverRun {
  const r = spawnSync(process.execPath, ['--import', TSX_LOADER, DRIVER], {
    env: { ...process.env, DOJO_HOME: box.home, HOME: box.home, PATH: `${box.bin}:${process.env.PATH ?? ''}`, ...env },
    encoding: 'utf8', timeout: 120_000,
  });
  const line = (r.stdout ?? '').split('\n').filter((l) => l.startsWith('RESULT ')).pop();
  return {
    status: r.status, signal: r.signal, out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    result: line ? JSON.parse(line.slice('RESULT '.length)) : null,
  };
}

/** rollback.sh against the scratch box (its launchctl is the stub). */
export function runRollbackSh(box: Box, args: string[] = [], env: Record<string, string> = {}): { code: number; out: string } {
  try {
    const out = execFileSync('bash', [ROLLBACK_SH, ...args], {
      env: { ...process.env, HOME: box.home, DOJO_HOME: box.home, PATH: `${box.bin}:${process.env.PATH ?? ''}`, DOJO_PORT: '1', ...env },
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

export function readJson(p: string): Record<string, unknown> | null {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>; } catch { return null; }
}

export function versionAt(dir: string): string | null {
  return (readJson(path.join(dir, 'package.json'))?.version as string | undefined) ?? null;
}

/** A database at a level: `_migrations` rows in apply order, and a `which` row naming the copy. */
/** A WAL-mode database, as the product keeps it. Closed cleanly its side files are gone; `crashed` leaves them. */
export function levelDb(file: string, applied: string[] | null, which: string, opts: { crashed?: boolean } = {}): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE which (v TEXT)');
  if (applied) db.exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  for (const n of applied ?? []) db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(n);
  db.prepare('INSERT INTO which VALUES (?)').run(which);
  const sides = opts.crashed ? ['-wal', '-shm'].map((s) => [file + s, fs.readFileSync(file + s)] as const) : [];
  db.close();
  for (const [p, bytes] of sides) fs.writeFileSync(p, bytes);
  return file;
}

/** The `which` row of a database made by `levelDb`. */
export function whichDb(file: string): string {
  const db = new Database(file, { readonly: true });
  try { return (db.prepare('SELECT v FROM which').get() as { v: string }).v; } finally { db.close(); }
}

/** A tree of `version` carrying migration files where an installed build keeps them. */
export function makeTreeWithSteps(dir: string, version: string, files: string[], opts: { native?: boolean } = {}): string {
  makeTree(dir, version, opts);
  const steps = path.join(dir, 'packages', 'server', 'dist', 'db', 'migrations');
  fs.mkdirSync(steps, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(steps, f), '-- step\n');
  return dir;
}
