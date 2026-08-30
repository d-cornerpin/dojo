// ════════════════════════════════════════════════════════════════════════════════════════
// THE ROLLBACK RESTORES THE BUILD THE EPISODE LEFT — NOT THE HIGHEST NUMBER ON DISK.
// (UPDATE-INTEGRITY U0, change 3.)
//
// ── THE DEFECT THIS FILE EXISTS FOR ─────────────────────────────────────────────────────
// `deploy/scripts/rollback.sh` chose its target by parsing a version out of each
// `platform.backup-*` directory NAME and taking the highest. W52 ran that real function
// against a real user's real backup set and it chose a PRE-RELEASE:
//
//     3.1.12               -> 00030001001210000
//     3.1.16               -> 00030001001610000
//     3.1.17-preflight.20  -> 00030001001700020   <- highest, and it won
//     3.1.17               -> 00030001001710000
//
// The key compared the base version first, so `…0017…` beat `…0016…` and the pre-release
// rank byte was only ever reached on a tie. That is correct SEMVER ordering and the wrong
// question: the script's own header says it is looking for "the most recent GOOD build we
// left", and a pre-release of a later version is not that. It is how a stable box was
// automatically downgraded onto a preflight build and left stranded there.
//
// ── THE TWO CHANGES, AND WHY BOTH ───────────────────────────────────────────────────────
//   1. THE EPISODE'S OWN BACKUP FIRST. `~/.dojo/update-state.json` records `backupDir` — the
//      absolute path of the copy made right before the swap, by the updater, in the episode
//      being rolled back. That is not a guess about which build was good; it is the record.
//      Name-parsing is now the FALLBACK, for a box with no episode state (a hand-run
//      rollback, an older marker, a consumed backup).
//   2. THE FALLBACK RANKS STABILITY FIRST. A stable release outranks any pre-release; among
//      stables the higher version wins; among pre-releases of the same base, the higher
//      ordinal. The rollback path is a safety net, and a net that can drop somebody onto a
//      pre-release is a net with a hole in it.
//
// ── HERMETIC ────────────────────────────────────────────────────────────────────────────
// The REAL script runs, with `HOME` redirected into a scratch directory and a stub
// `launchctl` first on `PATH`. Nothing outside the scratch tree is read or written and no
// launchd job is touched — asserted below by the stub's own log.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../../..');
const SCRIPT = path.join(REPO_ROOT, 'deploy/scripts/rollback.sh');

let home: string;
let dojo: string;
let binDir: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'w53-rollback-'));
  dojo = path.join(home, '.dojo');
  fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
  fs.mkdirSync(dojo, { recursive: true });
  // A stub `launchctl` that records its arguments instead of talking to launchd.
  binDir = path.join(home, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, 'launchctl'),
    `#!/bin/sh\necho "$@" >> "${path.join(home, 'launchctl.log')}"\nexit 0\n`,
    { mode: 0o755 },
  );
});

afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

/** A directory that looks like an installed platform build of `version`. */
function makeBuild(dir: string, version: string): string {
  fs.mkdirSync(path.join(dir, 'packages', 'server', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dojo-platform', version }));
  fs.writeFileSync(path.join(dir, 'packages', 'server', 'dist', 'index.js'), '// build\n');
  return dir;
}

function backup(version: string): string {
  return makeBuild(path.join(dojo, `platform.backup-${version}`), version);
}

function currentPlatform(version: string): string {
  return makeBuild(path.join(dojo, 'platform'), version);
}

function marker(fields: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dojo, 'update-state.json'), JSON.stringify(fields, null, 2));
}

function runRollback(): { code: number; out: string } {
  try {
    const out = execFileSync('bash', [SCRIPT], {
      env: { ...process.env, HOME: home, PATH: `${binDir}:${process.env.PATH ?? ''}` },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** The version now installed at `~/.dojo/platform`, read the way the product reads it. */
function installedVersion(): string {
  const raw = fs.readFileSync(path.join(dojo, 'platform', 'package.json'), 'utf-8');
  return (JSON.parse(raw) as { version: string }).version;
}

const backupsLeft = (): string[] => fs.readdirSync(dojo)
  .filter((f) => f.startsWith('platform.backup-')).sort();

// ────────────────────────────────────────────────────────────────────────────────────────

describe('the harness is hermetic', () => {
  it('POSITIVE: launchd is never touched — the stub takes every call', () => {
    currentPlatform('3.1.17');
    backup('3.1.16');
    expect(runRollback().code).toBe(0);
    const log = fs.readFileSync(path.join(home, 'launchctl.log'), 'utf-8');
    expect(log).toContain('unload');
    expect(log).toContain('load');
    expect(log).toContain(path.join(home, 'Library', 'LaunchAgents'));
  });
});

describe("MICHAEL'S SET — a stable box must not be rolled onto a pre-release", () => {
  beforeEach(() => {
    // His exact on-disk set at the moment the watchdog rolled him back: he was running
    // preflight.20 when he took stable 3.1.17, so `update.ts:686` had stamped
    // `platform.backup-3.1.17-preflight.20` with the OUTGOING version.
    currentPlatform('3.1.17');
    backup('3.1.12');
    backup('3.1.16');
    backup('3.1.17-preflight.20');
  });

  it('POSITIVE: with no episode state, the fallback picks 3.1.16 — NOT preflight.20', () => {
    const r = runRollback();
    expect(r.code).toBe(0);
    expect(installedVersion()).toBe('3.1.16');
    expect(r.out).toContain('3.1.16');
  });

  it('POSITIVE: the pre-release backup is left on disk, unconsumed', () => {
    runRollback();
    expect(backupsLeft()).toContain('platform.backup-3.1.17-preflight.20');
    expect(backupsLeft()).not.toContain('platform.backup-3.1.16');
  });

  it('POSITIVE: the failed build is preserved for diagnosis, as before', () => {
    runRollback();
    const failed = fs.readdirSync(dojo).filter((f) => f.startsWith('platform.failed-3.1.17-'));
    expect(failed).toHaveLength(1);
  });
});

describe("the episode's own recorded backup wins over any name on disk", () => {
  it('POSITIVE: `backupDir` from update-state.json is restored even when a higher one exists', () => {
    currentPlatform('3.1.18');
    const target = backup('3.1.16');
    backup('3.1.17-preflight.33');
    backup('3.1.12');
    marker({
      phase: 'booting-new', targetVersion: '3.1.18', previousVersion: '3.1.16',
      backupDir: target, bootAttempts: 2, rollbackCount: 0, writeSeq: 3,
    });
    const r = runRollback();
    expect(r.code).toBe(0);
    expect(installedVersion()).toBe('3.1.16');
    expect(backupsLeft()).toContain('platform.backup-3.1.17-preflight.33');
  });

  it('POSITIVE: it is used even when the recorded dir is NOT the highest stable either', () => {
    currentPlatform('3.1.18');
    const target = backup('3.1.12');
    backup('3.1.16');
    marker({ phase: 'booting-new', previousVersion: '3.1.12', backupDir: target });
    expect(runRollback().code).toBe(0);
    expect(installedVersion()).toBe('3.1.12');
  });

  it('NEGATIVE: a recorded dir that is gone falls back to the version sort, never aborts', () => {
    currentPlatform('3.1.18');
    backup('3.1.16');
    backup('3.1.17-preflight.20');
    marker({ phase: 'rolled-back', backupDir: path.join(dojo, 'platform.backup-3.1.15') });
    expect(runRollback().code).toBe(0);
    expect(installedVersion()).toBe('3.1.16');
  });

  it('NEGATIVE: a recorded dir that is not a build falls back — a torn backup is not a target', () => {
    currentPlatform('3.1.18');
    const torn = path.join(dojo, 'platform.backup-3.1.17-preflight.20');
    fs.mkdirSync(torn, { recursive: true });          // no package.json: the copy was cut short
    backup('3.1.16');
    marker({ phase: 'booting-new', backupDir: torn });
    expect(runRollback().code).toBe(0);
    expect(installedVersion()).toBe('3.1.16');
  });

  it('NEGATIVE: a malformed marker is ignored, not fatal', () => {
    currentPlatform('3.1.18');
    backup('3.1.16');
    fs.writeFileSync(path.join(dojo, 'update-state.json'), '{ this is not json');
    expect(runRollback().code).toBe(0);
    expect(installedVersion()).toBe('3.1.16');
  });

  it('NEGATIVE: an empty `backupDir` is ignored, not treated as a path', () => {
    currentPlatform('3.1.18');
    backup('3.1.16');
    marker({ phase: 'idle', backupDir: null });
    expect(runRollback().code).toBe(0);
    expect(installedVersion()).toBe('3.1.16');
  });
});

describe('the version fallback ranks stability first, then version', () => {
  it('POSITIVE: a stable release outranks its OWN preflight', () => {
    currentPlatform('3.1.18');
    backup('3.1.17');
    backup('3.1.17-preflight.33');
    expect(runRollback().code).toBe(0);
    expect(installedVersion()).toBe('3.1.17');
  });

  it('POSITIVE: among stables, the higher version still wins', () => {
    currentPlatform('3.1.18');
    backup('3.1.12');
    backup('3.1.16');
    backup('3.1.17');
    expect(runRollback().code).toBe(0);
    expect(installedVersion()).toBe('3.1.17');
  });

  it('POSITIVE: with only pre-releases on disk, the higher ordinal wins', () => {
    currentPlatform('3.1.18');
    backup('3.1.17-preflight.20');
    backup('3.1.17-preflight.33');
    expect(runRollback().code).toBe(0);
    expect(installedVersion()).toBe('3.1.17-preflight.33');
  });

  it('POSITIVE: a pre-release of a LOWER base still loses to any stable', () => {
    currentPlatform('3.1.18');
    backup('3.1.16-rc.9');
    backup('3.1.12');
    expect(runRollback().code).toBe(0);
    expect(installedVersion()).toBe('3.1.12');
  });

  it('NEGATIVE: no backups at all is still a clean refusal, not a half-move', () => {
    currentPlatform('3.1.18');
    const r = runRollback();
    expect(r.code).toBe(1);
    expect(r.out).toContain('nothing to roll back to');
    expect(installedVersion()).toBe('3.1.18');
  });

  it('NEGATIVE: a malformed directory name cannot crash the recovery path', () => {
    currentPlatform('3.1.18');
    makeBuild(path.join(dojo, 'platform.backup-not-a-version'), 'not-a-version');
    backup('3.1.16');
    expect(runRollback().code).toBe(0);
    expect(installedVersion()).toBe('3.1.16');
  });
});
