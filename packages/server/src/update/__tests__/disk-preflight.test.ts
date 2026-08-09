// ════════════════════════════════════════════════════════════════════════════════════════
// THE UPDATE CHECKS DISK SPACE AND TELLS THE USER — the owner's ask of 2026-08-06, landed by
// SWEEP CORE-2 item 3 (SWEEP-F's INBOUND). His words:
//
//   *"add a disk space check to the update mechanism so we can give the user a notification
//    either before the update starts, or if it fails, when they don't have enough disk space."*
//
// ── WHAT WAS ALREADY THERE, AND WHAT WAS NOT (re-derived at HEAD, #14) ──────────────────
// SWEEP-A's RESTORE-PATH built the AFTER-THE-FACT half: `db/migration-backup.ts` refuses the
// migration chain when free disk is under 2x the live database, records the outcome in
// `config.migration_backup_last`, and the Update tab renders it. That refusal is MEASURED to
// be protective — with nothing applied, the watchdog's `decideAutoRollback` returns `rollback`
// instead of `escalate` (task-RESTORE-PATH-report.md, three recorded verdicts).
//
// What did not exist is the CHECK BEFORE THE USER COMMITS. `applyUpdate` performed ZERO
// free-space measurement before `curl` -> `unzip` -> `cp -R` of a 100-200 MB tree, in a module
// whose own header says these backups "have been reported to fill mac mini disks". A box short
// on space downloaded, extracted, copied, swapped, restarted — and only THEN met a refusal, at
// a point where the dashboard is down and the message reaches a log file.
//
// And nothing anywhere tested the arithmetic. `grep -rn "statfs|skipped-low-disk" --include
// "*.test.ts" packages/` returned ZERO hits: the low-disk branch's only two measurements ever
// were one-off manual rehearsals recorded in prose.
//
// ── THE FOUR REQUIREMENTS, EACH A CLAUSE BELOW ─────────────────────────────────────────
//   B1-B2  PRE-FLIGHT, DERIVED NEVER GUESSED. Every component of the need is measured from
//          this box or read from the release's own metadata, and the backup multiple is
//          IMPORTED from the module that enforces it rather than copied.
//   B3-B4  IT SAYS WHAT IS SHORT AND BY HOW MUCH, in plain words, and stays quiet when there
//          is room (the negative control — a warning that always fires is not a warning).
//   B5-B6  REFUSE RATHER THAN PROCEED, before a single byte is downloaded, with the explicit
//          override preserved — and PEEKED at, never consumed, because the migration-stage
//          refusal downstream still needs the one-shot file to be there.
//   B7     A MID-UPDATE FAILURE FOR SPACE SAYS SO. Not `Update failed: ENOSPC`.
//   B8-B9  It reaches the owner where he already looks, and an unmeasurable volume does not
//          block (the convention `migration-backup.ts` and `routes/migration.ts` both keep).
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let scratch: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-disk-preflight-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** A database body of a known size, plus its WAL and SHM — the live footprint. */
function seedBody(mainBytes: number, walBytes = 0, shmBytes = 0): string {
  const dbPath = path.join(scratch, 'dojo.db');
  fs.writeFileSync(dbPath, Buffer.alloc(mainBytes));
  if (walBytes) fs.writeFileSync(`${dbPath}-wal`, Buffer.alloc(walBytes));
  if (shmBytes) fs.writeFileSync(`${dbPath}-shm`, Buffer.alloc(shmBytes));
  return dbPath;
}

/** An installed platform tree of a known size. */
function seedPlatform(bytes: number): string {
  const dir = path.join(scratch, 'platform');
  fs.mkdirSync(path.join(dir, 'packages'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'packages', 'blob'), Buffer.alloc(bytes));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"version":"1.0.0"}');
  return dir;
}

/** Constrain the volume, the way an 80 MB disk image does — but deterministically. */
function constrainVolume(freeBytes: number): void {
  vi.spyOn(fs, 'statfsSync').mockReturnValue({
    bavail: freeBytes, bsize: 1, bfree: freeBytes, blocks: freeBytes, ffree: 0, files: 0, type: 0,
  } as unknown as ReturnType<typeof fs.statfsSync>);
}

// ════════════════════════════════════════════════════════════════════════════════
// B1/B2 — THE NEED IS DERIVED
// ════════════════════════════════════════════════════════════════════════════════

describe('B1 the need is measured, never guessed', () => {
  it('the backup component is the live footprint times the multiple the enforcer uses', async () => {
    const { measureUpdateDiskNeed } = await import('../disk-preflight.js');
    const { MIGRATION_BACKUP_FREE_DISK_MULTIPLE } = await import('../../db/migration-backup.js');
    const dbPath = seedBody(4_000, 1_000, 500);
    const platformDir = seedPlatform(10_000);
    constrainVolume(1e12);

    const need = measureUpdateDiskNeed({ artifactBytes: 7_000, dbPath, platformDir });
    // main + wal + shm — a busy box carries recent writes in the WAL until the next checkpoint.
    expect(need.dbBytes).toBe(5_500);
    expect(need.backupNeedBytes).toBe(5_500 * MIGRATION_BACKUP_FREE_DISK_MULTIPLE);
  });

  it('the multiple is IMPORTED from the module that enforces it, not copied', async () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'disk-preflight.ts'), 'utf8');
    expect(src).toMatch(/MIGRATION_BACKUP_FREE_DISK_MULTIPLE/);
    // A local `= 2` here would be the two-copies-cannot-be-ordered defect this tree keeps closing.
    expect(src).not.toMatch(/FREE_DISK_MULTIPLE\s*=\s*\d/);
  });

  it('the artifact headroom is the release\'s OWN size plus the tree measured on this disk', async () => {
    const { measureUpdateDiskNeed } = await import('../disk-preflight.js');
    const dbPath = seedBody(1_000);
    const platformDir = seedPlatform(50_000);
    constrainVolume(1e12);

    const need = measureUpdateDiskNeed({ artifactBytes: 9_999, dbPath, platformDir });
    expect(need.artifactBytes).toBe(9_999);
    // The installed tree is MEASURED — a change on disk moves the number.
    expect(need.platformBytes).toBeGreaterThanOrEqual(50_000);
    // Three things land on the disk during an apply: the zip, its extracted tree, and the
    // `cp -R` copy of the current install.
    expect(need.totalNeedBytes).toBe(
      need.backupNeedBytes + need.artifactBytes + need.platformBytes * 2);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// B3/B4 — IT SAYS WHAT IS SHORT AND BY HOW MUCH, AND IS QUIET WHEN THERE IS ROOM
// ════════════════════════════════════════════════════════════════════════════════

describe('B3 the constrained volume is refused, in plain words', () => {
  it('names the shortfall, the need and the free space — with units a person reads', async () => {
    const { measureUpdateDiskNeed, describeUpdateDiskShortfall } = await import('../disk-preflight.js');
    const dbPath = seedBody(31_346_688);           // the REVERT-REHEARSE body, to the byte
    const platformDir = seedPlatform(20_000_000);
    constrainVolume(50_536_448);                    // that rehearsal's measured free space

    const need = measureUpdateDiskNeed({ artifactBytes: 31_000_000, dbPath, platformDir });
    expect(need.ok).toBe(false);
    expect(need.shortfallBytes).toBeGreaterThan(0);

    const said = describeUpdateDiskShortfall(need);
    expect(said).toMatch(/disk space/i);
    // A unit a person reads. Scale-aware: MB below a gigabyte, GB above — "0.03 GB" on a
    // 31 MB database is a number that tells the owner nothing about the size of his problem.
    expect(said).toMatch(/\b(GB|MB)\b/);
    // The three numbers a person needs: what it needs, what it has, and the difference.
    expect(said).toMatch(/free/i);
    expect(said).toMatch(/needs?/i);
    // Not an error code, not a stack, not a byte count nobody can read.
    expect(said).not.toMatch(/ENOSPC|statfs|bavail/);
  });
});

describe('B4 the negative control: a roomy volume produces no warning', () => {
  it('ok, no shortfall, and nothing to say', async () => {
    const { measureUpdateDiskNeed } = await import('../disk-preflight.js');
    const dbPath = seedBody(31_346_688);
    const platformDir = seedPlatform(20_000_000);
    constrainVolume(500e9);

    const need = measureUpdateDiskNeed({ artifactBytes: 31_000_000, dbPath, platformDir });
    expect(need.ok).toBe(true);
    expect(need.shortfallBytes).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// B5/B6 — REFUSE BEFORE THE DOWNLOAD; THE OVERRIDE SURVIVES AND IS NOT CONSUMED
// ════════════════════════════════════════════════════════════════════════════════

describe('B5 the refusal comes before anything is downloaded', () => {
  it('applyUpdate consults the pre-flight before its first curl', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'gateway', 'routes', 'update.ts'), 'utf8');
    const applyAt = src.indexOf('export async function applyUpdate');
    expect(applyAt).toBeGreaterThan(-1);
    const body = src.slice(applyAt);
    const preflightAt = body.indexOf('measureUpdateDiskNeed');
    const curlAt = body.indexOf('curl -L -o');
    expect(preflightAt, 'applyUpdate never consults the pre-flight').toBeGreaterThan(-1);
    expect(preflightAt, 'the pre-flight must run BEFORE the download, not after it')
      .toBeLessThan(curlAt);
  });

  it('the refusal is the loud kind, with its own status', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'gateway', 'routes', 'update.ts'), 'utf8');
    // 507 Insufficient Storage — the one status that says this without a paragraph.
    expect(src).toMatch(/status:\s*507/);
  });
});

describe('B6 the explicit override is preserved, and only PEEKED at', () => {
  it('an override lets the update through', async () => {
    const { measureUpdateDiskNeed, updateDiskRefusal } = await import('../disk-preflight.js');
    const dbPath = seedBody(31_346_688);
    const platformDir = seedPlatform(20_000_000);
    constrainVolume(50_536_448);
    const need = measureUpdateDiskNeed({ artifactBytes: 31_000_000, dbPath, platformDir });

    expect(updateDiskRefusal(need, { dataDir: scratch })).not.toBeNull();
    vi.stubEnv('DOJO_ALLOW_MIGRATION_WITHOUT_BACKUP', '1');
    expect(updateDiskRefusal(need, { dataDir: scratch })).toBeNull();
  });

  it('the one-shot FILE is not consumed by the pre-flight — the chain still needs it', async () => {
    const { measureUpdateDiskNeed, updateDiskRefusal } = await import('../disk-preflight.js');
    const { MIGRATION_BACKUP_OVERRIDE_FILE } = await import('../../db/migration-backup.js');
    const dbPath = seedBody(31_346_688);
    const platformDir = seedPlatform(20_000_000);
    constrainVolume(50_536_448);
    const need = measureUpdateDiskNeed({ artifactBytes: 31_000_000, dbPath, platformDir });

    const overridePath = path.join(scratch, MIGRATION_BACKUP_OVERRIDE_FILE);
    fs.writeFileSync(overridePath, '');
    expect(updateDiskRefusal(need, { dataDir: scratch })).toBeNull();
    expect(
      fs.existsSync(overridePath),
      'the pre-flight ATE the one-shot override; the migration chain would then refuse anyway',
    ).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// B7 — A MID-UPDATE FAILURE FOR SPACE SAYS SO
// ════════════════════════════════════════════════════════════════════════════════

describe('B7 running out of space mid-update is not a generic error', () => {
  it('recognises the shapes a full disk actually throws', async () => {
    const { isOutOfSpaceError } = await import('../disk-preflight.js');
    expect(isOutOfSpaceError(Object.assign(new Error('write failed'), { code: 'ENOSPC' }))).toBe(true);
    expect(isOutOfSpaceError(new Error('cp: error writing: No space left on device'))).toBe(true);
    expect(isOutOfSpaceError(new Error('unzip: write error (disk full?)'))).toBe(true);
    // The negative control: an ordinary failure is NOT relabelled as a disk problem.
    expect(isOutOfSpaceError(new Error('curl: (22) The requested URL returned error: 404'))).toBe(false);
  });

  it('the byte formatter scales — MB below a gigabyte, GB above', async () => {
    const { readableBytes } = await import('../disk-preflight.js');
    expect(readableBytes(31_346_688)).toBe('31 MB');
    expect(readableBytes(2_500_000_000)).toBe('2.50 GB');
  });

  it('the mid-failure sentence says "disk space" in words, not a code', async () => {
    const { outOfSpaceFailureMessage } = await import('../disk-preflight.js');
    const said = outOfSpaceFailureMessage('cp: No space left on device');
    expect(said).toMatch(/ran out of disk space/i);
    expect(said).not.toMatch(/^Update failed: ENOSPC/);
    // It must also say the box is unharmed or what to do — a bare diagnosis is not help.
    expect(said.length).toBeGreaterThan(60);
  });

  it('applyUpdate routes its failure through that sentence', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'gateway', 'routes', 'update.ts'), 'utf8');
    const applyAt = src.indexOf('export async function applyUpdate');
    const body = src.slice(applyAt);
    expect(body).toMatch(/isOutOfSpaceError/);
    expect(body).toMatch(/outOfSpaceFailureMessage/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// B8/B9 — IT REACHES HIM WHERE HE LOOKS; AN UNMEASURABLE VOLUME DOES NOT BLOCK
// ════════════════════════════════════════════════════════════════════════════════

describe('B8 the answer reaches the Update tab RESTORE-PATH built', () => {
  it('the check result carries the pre-flight, so the tab needs no second round-trip', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'gateway', 'routes', 'update.ts'), 'utf8');
    const iface = src.slice(src.indexOf('export interface UpdateCheckResult'),
      src.indexOf('export async function checkForUpdate'));
    expect(iface).toMatch(/disk\??:/);
  });

  it('the Update tab renders it beside the backup notice, and gates the button on it', () => {
    const settings = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', '..', 'dashboard', 'src', 'pages', 'Settings.tsx'), 'utf8');
    const tabAt = settings.indexOf('const UpdateTab');
    expect(tabAt).toBeGreaterThan(-1);
    const tab = settings.slice(tabAt, tabAt + 12000);
    expect(tab).toMatch(/DiskSpaceNotice/);
    // The button must not invite a click the platform is about to refuse.
    expect(tab).toMatch(/updateInfo\?\.disk/);
  });
});

describe('B9 an unmeasurable volume does not block the update', () => {
  it('a statfs that throws is reported, not treated as empty', async () => {
    const { measureUpdateDiskNeed } = await import('../disk-preflight.js');
    const dbPath = seedBody(1_000);
    const platformDir = seedPlatform(1_000);
    vi.spyOn(fs, 'statfsSync').mockImplementation(() => { throw new Error('statfs unsupported'); });

    const need = measureUpdateDiskNeed({ artifactBytes: 1_000, dbPath, platformDir });
    expect(need.measured).toBe(false);
    expect(need.freeBytes).toBeNull();
    // The convention `migration-backup.ts:155` and `routes/migration.ts:147` both keep: a
    // platform that cannot answer the question must not invent a NO.
    expect(need.ok).toBe(true);
    expect(need.shortfallBytes).toBe(0);
  });
});
