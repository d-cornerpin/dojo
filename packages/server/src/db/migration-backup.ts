import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { createLogger } from '../logger.js';

const logger = createLogger('migration-backup');

// ════════════════════════════════════════════════════════════════════════════════
// THE PRE-MIGRATION RESTORE POINT — written, said out loud, and REQUIRED.
//
// Owner decision D-F is a deliberate NO-rollback-after-migrations policy: once a
// migration has changed the database, putting the old app back is not allowed to be
// automatic, because old code on a new schema can brick a box. The whole thing that
// makes that policy survivable is THIS snapshot: the person can put their data back
// by hand. So two rules follow from the policy, and this module is both of them.
//
//   1. THE OUTCOME IS ON THE RECORD. Written, skipped or failed, it is stored in the
//      `config` table where a route can read it and a person can be shown it. It used
//      to be a log line: `info` for the success (never broadcast at all) and
//      `warn`/`error` for the misses (broadcast-eligible, but emitted ~630 lines
//      before the broadcast callback exists). The one fact that decides whether an
//      update can be undone reached no surface the product has.
//
//   2. NO RESTORE POINT, NO CHAIN. If the snapshot cannot be written, the chain does
//      not run. It used to run anyway, in silence, leaving a changed database with no
//      way back — the exact shape that strands somebody. Refusing costs a boot;
//      proceeding costs the data.
//
// The refusal has two deliberate limits and an escape hatch, all three load-bearing:
//   * A database with NOTHING applied yet is never held up. A fresh install has no
//     restore point worth having, and refusing there would brick a new box over a
//     backup of nothing.
//   * A connection with no file on disk is not in scope at all (see the destination
//     note below).
//   * A person who would rather go forward than be able to go back can say so, once,
//     and be believed — the override below.
//
// WHERE THE SNAPSHOT GOES: beside the database it is a snapshot OF (`db.name`), never
// a module-global path. See db/__tests__/migration-backup-location.test.ts for why
// that distinction is not academic.
// ════════════════════════════════════════════════════════════════════════════════

/** `config` key holding the last outcome, as JSON. Read by GET /api/update/db-backup. */
export const MIGRATION_BACKUP_CONFIG_KEY = 'migration_backup_last';

/**
 * One-shot override, relative to the data directory (i.e.
 * `~/.dojo/data/allow-migration-without-backup` on a real box). A FILE and not a
 * setting on purpose: it has to be usable on a box whose server will not start, which
 * rules out every surface that needs the server. Consumed — deleted — the moment it is
 * honoured, so "let me through this once" can never become "never protect me again".
 */
export const MIGRATION_BACKUP_OVERRIDE_FILE = 'allow-migration-without-backup';

/** The same permission for scripted and packaging boots, which have no data to lose. */
export const MIGRATION_BACKUP_OVERRIDE_ENV = 'DOJO_ALLOW_MIGRATION_WITHOUT_BACKUP';

/**
 * Free space must hold ~2x the live footprint: VACUUM INTO writes a full copy.
 *
 * EXPORTED by SWEEP CORE-2 item 3 so the update path's PRE-flight and this POST-download
 * enforcer cannot drift. Two copies of a threshold cannot be ordered, and a pre-flight that
 * says "you have room" against a number the enforcer does not use is worse than no pre-flight
 * — it is a promise the next boot breaks.
 */
export const MIGRATION_BACKUP_FREE_DISK_MULTIPLE = 2;
const FREE_DISK_MULTIPLE = MIGRATION_BACKUP_FREE_DISK_MULTIPLE;

export interface MigrationBackupOutcome {
  /**
   * `written`         — a restore point exists at `path`.
   * `skipped-low-disk`— the free-space guard refused to try.
   * `failed`          — the snapshot was attempted and did not land.
   * `not-applicable`  — nothing to back up (fresh body, or a connection with no file).
   */
  status: 'written' | 'skipped-low-disk' | 'failed' | 'not-applicable';
  /** ISO timestamp of the decision. */
  at: string;
  /** True when the chain was allowed to run WITHOUT a restore point on someone's say-so. */
  overridden: boolean;
  /** How many migrations the chain was about to apply. */
  pendingMigrations: number;
  path?: string;
  bytes?: number;
  durationMs?: number;
  freeBytes?: number;
  dbBytes?: number;
  neededBytes?: number;
  error?: string;
  reason?: string;
}

/** Thrown to stop the migration chain when no restore point could be made. */
export class MigrationBackupRequiredError extends Error {
  readonly outcome: MigrationBackupOutcome;
  constructor(message: string, outcome: MigrationBackupOutcome) {
    super(message);
    this.name = 'MigrationBackupRequiredError';
    this.outcome = outcome;
  }
}

function fileSize(p: string): number {
  try { return fs.statSync(p).size; } catch { return 0; }
}

function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

/** Store the outcome where a surface can read it. Never allowed to break a boot. */
function recordOutcome(db: Database.Database, outcome: MigrationBackupOutcome): void {
  try {
    db.prepare(
      `INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(MIGRATION_BACKUP_CONFIG_KEY, JSON.stringify(outcome));
  } catch (err) {
    logger.warn('Could not record the pre-migration backup outcome', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The last thing this box did about a pre-migration restore point, or null if never. */
export function readLastMigrationBackup(db: Database.Database): MigrationBackupOutcome | null {
  try {
    const row = db.prepare('SELECT value FROM config WHERE key = ?')
      .get(MIGRATION_BACKUP_CONFIG_KEY) as { value: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.value) as MigrationBackupOutcome;
  } catch {
    return null;
  }
}

/**
 * Take the snapshot. Best-effort by construction: this never throws, it reports.
 * The decision about what a miss MEANS belongs to `ensurePreChainBackup` below.
 */
function takeSnapshot(
  db: Database.Database,
  dbPath: string,
  allFiles: string[],
  pending: string[],
): MigrationBackupOutcome {
  const at = new Date().toISOString();
  const base = { at, overridden: false, pendingMigrations: pending.length };
  const dataDir = path.dirname(dbPath);
  const backupsDir = path.join(dataDir, 'backups');

  // Live footprint = main file + WAL + SHM (a busy box carries recent writes in the
  // WAL until the next checkpoint).
  const dbBytes = fileSize(dbPath) + fileSize(`${dbPath}-wal`) + fileSize(`${dbPath}-shm`);

  try {
    const stat = fs.statfsSync(dataDir);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    const neededBytes = dbBytes * FREE_DISK_MULTIPLE;
    if (freeBytes < neededBytes) {
      return { ...base, status: 'skipped-low-disk', freeBytes, dbBytes, neededBytes };
    }
  } catch (err) {
    // statfs unavailable on this platform: proceed. A truly full disk makes the
    // VACUUM INTO below fail, which is reported as `failed` rather than guessed at.
    logger.debug('Free-disk check unavailable for pre-migration backup; proceeding', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    fs.mkdirSync(backupsDir, { recursive: true });

    const migNumber = (f: string): number => {
      const n = parseInt(f.slice(0, f.indexOf('_')), 10);
      return Number.isFinite(n) ? n : 0;
    };
    const lastApplied = allFiles
      .filter(f => !pending.includes(f))
      .reduce((max, f) => Math.max(max, migNumber(f)), 0);
    const target = allFiles.reduce((max, f) => Math.max(max, migNumber(f)), 0);
    // Timestamped so same-day re-runs never collide (VACUUM INTO refuses to
    // overwrite an existing file).
    const stamp = at.replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = path.join(backupsDir, `dojo-pre-${lastApplied}-to-${target}-${stamp}.db`);
    try { fs.rmSync(backupPath, { force: true }); } catch { /* nothing to remove */ }

    const started = Date.now();
    // VACUUM INTO is an ONLINE snapshot that folds committed WAL frames into a
    // consistent copy. NOT fs.copyFile, which on a live WAL database would copy the
    // main file without the un-checkpointed WAL and yield a torn/stale backup.
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    const outcome: MigrationBackupOutcome = {
      ...base,
      status: 'written',
      path: backupPath,
      bytes: fileSize(backupPath),
      durationMs: Date.now() - started,
      dbBytes,
    };

    // ── Prune: the newest 2 restore points, AND NEVER THIS EPISODE'S BASELINE ──
    //
    // Keeping the newest 2 by mtime is safe right up until the chain starts failing,
    // and then it eats the one file it exists for. Measured (W52, on the reproduced
    // incident body): the first boot wrote the genuine restore point — the body BEFORE
    // the chain touched it — the chain aborted, launchd's KeepAlive restarted the
    // process every ten seconds, and each retry wrote another snapshot OF THE ALREADY-
    // BROKEN STATE. The third one pushed the good file out. About thirty seconds, and
    // the user was left holding two 1.57 GB copies of the state he needed to escape.
    //
    // So the episode's BASELINE is pinned: of the snapshots taken on the way to the same
    // TARGET level, the one taken from the lowest applied level — the furthest back this
    // box can still go. Retention becomes "the newest 2 plus one pinned baseline", which
    // is three files rather than two: still a bounded cap, still one number, and the pin
    // selects exactly one file no matter how long the crash loop runs. It releases itself
    // when a later release moves the target, because that is a different episode with a
    // baseline of its own. A file whose name does not parse is never pinned and never
    // protects anything — the pin is derived from what the namer above wrote, not guessed.
    const KEEP_NEWEST = 2;
    try {
      const backups = fs.readdirSync(backupsDir)
        .filter(f => f.startsWith('dojo-pre-') && f.endsWith('.db'))
        .map(f => {
          const full = path.join(backupsDir, f);
          const named = /^dojo-pre-(\d+)-to-(\d+)-/.exec(f);
          return {
            full,
            from: named ? Number(named[1]) : null,
            to: named ? Number(named[2]) : null,
            mtimeMs: fs.statSync(full).mtimeMs,
          };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      const baseline = backups
        .filter(b => b.to === target && b.from !== null)
        .reduce<(typeof backups)[number] | null>(
          (lowest, b) => (
            !lowest || b.from! < lowest.from!
              || (b.from === lowest.from && b.mtimeMs < lowest.mtimeMs)
          ) ? b : lowest,
          null,
        );
      for (const stale of backups.slice(KEEP_NEWEST)) {
        if (baseline && stale.full === baseline.full) continue;
        try { fs.rmSync(stale.full, { force: true }); }
        catch (err) {
          logger.debug('Failed to prune old pre-migration backup', {
            file: stale.full, error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch { /* a prune problem is never worth losing the backup we just made */ }

    return outcome;
  } catch (err) {
    return {
      ...base,
      status: 'failed',
      dbBytes,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * True when the explicit override is PRESENT — without consuming it.
 *
 * SWEEP CORE-2 item 3: the update path's pre-flight has to know whether the owner has already
 * said "let me through", but it must not EAT the one-shot file, because the migration chain
 * that runs after the restart is the thing the file was written for. A pre-flight that
 * consumed it would let the download proceed and then refuse the chain anyway — the exact
 * shape of the failure this whole item exists to prevent.
 */
export function migrationBackupOverridePresent(dataDir: string): boolean {
  if (process.env[MIGRATION_BACKUP_OVERRIDE_ENV] === '1') return true;
  return fs.existsSync(path.join(dataDir, MIGRATION_BACKUP_OVERRIDE_FILE));
}

/** True when someone has explicitly said this chain may run with no way back. Consumes. */
function takeOverride(dataDir: string): boolean {
  if (process.env[MIGRATION_BACKUP_OVERRIDE_ENV] === '1') return true;
  const overridePath = path.join(dataDir, MIGRATION_BACKUP_OVERRIDE_FILE);
  if (!fs.existsSync(overridePath)) return false;
  // One-shot: consume it so the next update is protected again.
  try { fs.rmSync(overridePath, { force: true }); }
  catch (err) {
    logger.warn('Could not consume the migration-backup override file; it will be honoured again next boot', {
      path: overridePath, error: err instanceof Error ? err.message : String(err),
    });
  }
  return true;
}

function refusalMessage(outcome: MigrationBackupOutcome, dataDir: string): string {
  const n = outcome.pendingMigrations;
  const what = outcome.status === 'skipped-low-disk'
    ? `There is not enough free disk space to write it safely. `
      + `Writing the snapshot needs ${gb(outcome.neededBytes ?? 0)} free; this disk has `
      + `${gb(outcome.freeBytes ?? 0)} free. Your database is ${gb(outcome.dbBytes ?? 0)}.`
    : `Writing the snapshot failed: ${outcome.error ?? 'unknown error'}`;

  return [
    `Refusing to run ${n} database migration${n === 1 ? '' : 's'}: a backup of your data could not be made first.`,
    '',
    what,
    '',
    'Why this stops the update: these migrations change your data. Putting the old',
    'version of the app back does NOT undo them — only this backup can. Running them',
    'with no backup would leave you with no way back, so Dojo has changed nothing.',
    '',
    'What to do:',
    outcome.status === 'skipped-low-disk'
      ? `  1. Free up disk space (about ${gb(Math.max(0, (outcome.neededBytes ?? 0) - (outcome.freeBytes ?? 0)))} more), then start Dojo again.`
      : `  1. Fix the problem above in ${path.join(dataDir, 'backups')}, then start Dojo again.`,
    '     Dojo will make the backup itself and carry on.',
    '',
    '  2. Or, if you accept that you will not be able to go back, run this once and',
    '     start Dojo again:',
    `       touch ${path.join(dataDir, MIGRATION_BACKUP_OVERRIDE_FILE)}`,
  ].join('\n');
}

/**
 * Snapshot the live database before a pending chain applies, and decide what a miss
 * means. Returns normally when the chain may proceed. THROWS
 * `MigrationBackupRequiredError` when it may not — the one case where a backup problem
 * stops a boot, and the reason it does is in the message.
 */
export function ensurePreChainBackup(
  db: Database.Database,
  allFiles: string[],
  pending: string[],
): void {
  const at = new Date().toISOString();
  const dbPath = db.name;

  // No file on disk (`:memory:`, or a connection never given a path) means there is
  // nothing to snapshot and nowhere of its own to put it.
  if (!dbPath || dbPath === ':memory:' || !fs.existsSync(dbPath)) {
    recordOutcome(db, {
      status: 'not-applicable', at, overridden: false, pendingMigrations: pending.length,
      reason: 'this database has no file on disk',
    });
    return;
  }

  const dataDir = path.dirname(dbPath);

  // A body with nothing applied yet is a fresh install: there is no state a restore
  // point could return it to, and holding up its first boot over a backup of nothing
  // would brick a new box. This is the clause that keeps the refusal honest.
  const hasHistory = allFiles.some(f => !pending.includes(f));
  if (!hasHistory) {
    recordOutcome(db, {
      status: 'not-applicable', at, overridden: false, pendingMigrations: pending.length,
      reason: 'first run — no applied migrations to restore to',
    });
    return;
  }

  const outcome = takeSnapshot(db, dbPath, allFiles, pending);

  if (outcome.status === 'written') {
    recordOutcome(db, outcome);
    logger.info('Pre-migration DB backup written', {
      path: outcome.path, bytes: outcome.bytes,
      durationMs: outcome.durationMs, pendingMigrations: outcome.pendingMigrations,
    });
    return;
  }

  if (takeOverride(dataDir)) {
    const overridden = { ...outcome, overridden: true };
    recordOutcome(db, overridden);
    logger.warn(
      'Running the migration chain with NO database backup because an override was set. '
      + 'If this update goes wrong, the data cannot be put back.',
      { status: overridden.status, error: overridden.error,
        freeBytes: overridden.freeBytes, neededBytes: overridden.neededBytes,
        pendingMigrations: overridden.pendingMigrations },
    );
    return;
  }

  recordOutcome(db, outcome);
  const message = refusalMessage(outcome, dataDir);
  // Plain text to stderr as well as the structured log. launchd sends stderr to
  // ~/.dojo/logs/platform.stderr.log, so this is the ONE place the reason exists in a
  // form a person can read: the logger's own file holds it JSON-escaped on a single
  // line, which is unreadable at exactly the moment somebody needs to read it.
  process.stderr.write(`\n${message}\n\n`);
  logger.error('Refusing the migration chain: no database backup could be made', {
    status: outcome.status, error: outcome.error,
    freeBytes: outcome.freeBytes, neededBytes: outcome.neededBytes,
    dbBytes: outcome.dbBytes, pendingMigrations: outcome.pendingMigrations,
  });
  throw new MigrationBackupRequiredError(message, outcome);
}
