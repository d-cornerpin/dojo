// ── PHASE-2 T10, RULING 7 rider (a): a NAME is not evidence of what ran ──
//
// `_migrations` recorded name-only. On 2026-07-29 migration `139` was applied from an
// in-progress working tree missing its `root_kind <> 'a2a_thread'` clause; the author
// fixed the file 42 seconds later and committed it. Because the NAME was already
// recorded, the corrected file never re-ran, and the box carried a trigger that exists
// nowhere in the repo for six hours — aborting every fan-out piece landing, surfacing
// only as a swallowed `warn`. A code bisect could never find it: database objects do
// not move with the checkout.
//
// So we record WHAT we applied, and we say so at boot when the disk disagrees. This is a
// separate module from `migrations.ts` on purpose — the chain runner applies files; this
// answers a different question about them, and the growth gate was right to ask.

import crypto from 'node:crypto';
import type { getDb } from './connection.js';
import { createLogger } from '../logger.js';

const logger = createLogger('migrations');

/** Returns a migration file's text, or null when that file is no longer in the tree.
 *  Injected rather than read here: the chain runner already owns the directory and the
 *  filesystem, and this module answers a question ABOUT files, not one about disks. */
export type ReadMigration = (name: string) => string | null;

export type MigrationChecksumFinding = {
  file: string;
  /** `diverged`: the file exists and its content changed since it was applied.
   *  `superseded`: the file that was applied is no longer in the tree. */
  kind: 'diverged' | 'superseded';
  recorded: string;
  actual: string | null;
};

export type MigrationChecksumAudit = {
  /** recorded checksum matched the file on disk */
  verified: number;
  /** applied before checksums were recorded — a question, never a verdict (#15) */
  unverifiable: number;
  findings: MigrationChecksumFinding[];
};

type Db = ReturnType<typeof getDb>;

/**
 * Content address of a migration file.
 *
 * Line endings are normalised first, and ONLY line endings: a CRLF checkout must not
 * cry wolf (a warning that fires on nothing real stops being read), while a changed
 * clause — the thing this exists to catch — still moves the hash.
 */
export function migrationChecksum(sqlText: string): string {
  return crypto.createHash('sha256').update(sqlText.replace(/\r\n/g, '\n'), 'utf-8').digest('hex');
}

/**
 * Adds `_migrations.checksum` if it is not there yet. Idempotent — every boot calls it.
 *
 * Deliberately does NOT backfill: on every box that exists today the applied rows have
 * no honest checksum, and stamping them with whatever is on disk now would MANUFACTURE
 * agreement — it would have hidden the exact incident this rider was written for. Those
 * rows report as `unverifiable` and the count decays to zero as boxes move forward.
 */
export function ensureMigrationChecksumColumn(db: Db): void {
  const cols = db.prepare('PRAGMA table_info(_migrations)').all() as { name: string }[];
  if (cols.some(c => c.name === 'checksum')) return;
  db.exec('ALTER TABLE _migrations ADD COLUMN checksum TEXT');
}

/**
 * Compares every recorded migration against the file that bears its name.
 *
 * ── THE REFUSAL TIER, AND THE BRIDGE AUTHOR'S STORY (the design note RULING 7 asked for) ──
 *
 * This audit REPORTS. It does not throw, and the boot does not depend on it.
 *
 * The tempting policy — refuse to boot on divergence — is refused here, on the Bridge's
 * own terms (OR5: stable users must be able to update into this build). A lived-in box
 * legitimately reaches a diverged state without anybody doing anything wrong:
 *
 *   1. The Bridge's own skeletons (`129b`, `135b`) live OUTSIDE the repo and move INTO
 *      `db/migrations/` at the release that ships them. A box that ran one before it was
 *      folded in — or a box that runs the local chain and never sees it — records a name
 *      whose file is absent. That is `superseded`, and it is correct.
 *   2. A shipped migration that turns out to be wrong is fixed by a NEW numbered file, so
 *      the old one keeps its bytes. But a HOTFIX release that ever amends a shipped file
 *      would strand every box that already ran it — refusing the boot would turn a
 *      cosmetic divergence into a brick, on the owner's machine, with no way back in.
 *   3. Divergence is not, by itself, a statement that the schema is wrong. It says the
 *      RECIPE changed. Whether the box's schema is wrong is a different question and the
 *      harness already answers it directly (the kit's trigger-conformance guard, which
 *      refuses a RUN — the right place for a refusal, because a test run is disposable
 *      and a boot is not).
 *
 * What the loudness buys is the six hours: `logger.error` naming the file and both
 * hashes, on every boot, until somebody re-applies or re-numbers. That is the signal the
 * incident lacked entirely.
 */
export function auditMigrationChecksums(db: Db, read: ReadMigration): MigrationChecksumAudit {
  const audit: MigrationChecksumAudit = { verified: 0, unverifiable: 0, findings: [] };
  let rows: { name: string; checksum: string | null }[];
  try {
    rows = db.prepare('SELECT name, checksum FROM _migrations ORDER BY name').all() as typeof rows;
  } catch {
    return audit;
  }

  for (const row of rows) {
    if (row.checksum === null || row.checksum === undefined) {
      audit.unverifiable += 1;
      continue;
    }
    let onDisk: string | null;
    try {
      onDisk = read(row.name);
    } catch {
      onDisk = null;
    }
    if (onDisk === null) {
      audit.findings.push({ file: row.name, kind: 'superseded', recorded: row.checksum, actual: null });
      continue;
    }
    const actual = migrationChecksum(onDisk);
    if (actual === row.checksum) audit.verified += 1;
    else audit.findings.push({ file: row.name, kind: 'diverged', recorded: row.checksum, actual });
  }
  return audit;
}

/** The boot-time divergence check: audit, then say it out loud. Never throws — an audit
 *  must not be the reason a box cannot start. */
export function reportMigrationChecksums(db: Db, read: ReadMigration): MigrationChecksumAudit | null {
  try {
    const audit = auditMigrationChecksums(db, read);
    for (const f of audit.findings) {
      if (f.kind === 'diverged') {
        logger.error(
          'MIGRATION DIVERGENCE: this database was built by a version of this file that is not the version on disk. The schema it produced is NOT described by the repo, and re-running is not automatic (the name is already recorded). Re-apply deliberately or ship a new numbered migration.',
          { file: f.file, appliedChecksum: f.recorded, fileChecksum: f.actual },
        );
      } else {
        logger.warn(
          'Migration superseded: this database records a migration whose file is no longer in the tree (expected for Bridge skeletons folded in at release).',
          { file: f.file, appliedChecksum: f.recorded },
        );
      }
    }
    logger.info('Migration checksum audit', {
      verified: audit.verified,
      unverifiable: audit.unverifiable,
      diverged: audit.findings.filter(f => f.kind === 'diverged').length,
      superseded: audit.findings.filter(f => f.kind === 'superseded').length,
    });
    return audit;
  } catch (err) {
    logger.warn('Migration checksum audit failed; continuing', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
