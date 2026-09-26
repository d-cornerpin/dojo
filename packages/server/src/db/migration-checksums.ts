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

/**
 * An examined divergence, bound to the EXACT pair of hashes it was examined at.
 *
 * ── WHY THE LEDGER EXISTS (SWEEP CORE-2 item 6, rider (i)) ──
 * The `logger.error` below is right to be loud, and it was firing TWICE ON EVERY
 * BOOT of the dev box for months while nothing acted on it — and reaching the
 * behavioural harness as two permanent BLOCKING `ambient_log_error` findings in
 * every battery. An alarm that fires forever on a state nobody will change is a
 * silenced alarm, and worse than silence: it teaches every reader that a blocking
 * finding can be ignored. That is the instrument-rot class, and the answer is
 * never to lower the level — it is to make the alarm mean "NOBODY HAS LOOKED AT
 * THIS YET".
 *
 * ── WHY IT CANNOT BECOME A SILENCER ──
 * An entry names BOTH hashes: what this database applied, and what the file said
 * when a human examined it. It therefore cannot pre-approve a future edit — amend
 * the file again and `fileChecksum` moves, the triple stops matching, and the
 * error is back on the next boot. It also cannot be created by a box about
 * itself: it lives in the REPO, in source, where a reviewer reads it, and never
 * in the database whose honesty is in question.
 */
export type KnownDivergence = {
  file: string;
  /** The checksum recorded in `_migrations` on the boxes this covers. */
  appliedChecksum: string;
  /** The checksum of the file in the tree AT THE TIME IT WAS EXAMINED. */
  fileChecksum: string;
  /** ISO date of the adjudication. */
  since: string;
  /** What was measured, and what it means for the schema. Never "known issue". */
  reason: string;
};

export type MigrationChecksumFinding = {
  file: string;
  /** `diverged`: the file exists and its content changed since it was applied.
   *  `superseded`: the file that was applied is no longer in the tree. */
  kind: 'diverged' | 'superseded';
  recorded: string;
  actual: string | null;
  /** Present when this exact (file, recorded, actual) triple carries a ledger entry. */
  adjudicated?: KnownDivergence;
};

export type MigrationChecksumAudit = {
  /** recorded checksum matched the file on disk */
  verified: number;
  /** applied before checksums were recorded — a question, never a verdict (#15) */
  unverifiable: number;
  /** findings that carry a ledger entry — examined, and no longer news */
  adjudicated: number;
  findings: MigrationChecksumFinding[];
};

/**
 * ── THE DEV BOX's TWO, DIAGNOSED BY MEASUREMENT (2026-08-09) ──
 *
 * Both were amended by `54c7f73` ("hotfix(migrations): 144 tolerates duplicate
 * task_runs slots; 146 tolerates an unreadable instant") AFTER this database had
 * already applied them. Measured, not assumed: the checksums recorded in
 * `_migrations` are byte-identical to `git show 54c7f73^:<file>` for both files,
 * so this is REAL RECIPE DRIFT — the declaration is not stale.
 *
 * What the drift IS, and it is the part that decides the disposition. Diffing the
 * DDL of each version:
 *
 *     for f in 144_task_runs_absorbed.sql 146_task_log_absorbed.sql; do
 *       diff <(git show 54c7f73^:…/$f | grep -iE 'create |alter |drop |index|trigger|view ') \
 *            <(git show HEAD:…/$f     | grep -iE 'create |alter |drop |index|trigger|view ')
 *     done
 *
 * `146` is DDL-IDENTICAL. `144` differs only by the hotfix's own scratch tables
 * (`_mig144_cand`, `_mig144_slot` and one index on the latter), each created and
 * dropped inside the migration, leaving nothing behind. So the PERSISTENT SCHEMA
 * this database carries IS the schema the repo describes — which is exactly what
 * the alarm's own wording ("the schema it produced is NOT described by the repo")
 * would otherwise assert falsely, every boot, for ever.
 *
 * What actually differs is which historical ROWS the rescue carried: the amended
 * 144 keeps duplicate-slot runs as `work_events` audit rows instead of aborting,
 * and clamps a readable pre-2020 `opened_at`; the amended 146 dates an unreadable
 * `task_log` instant at its work row's `opened_at` instead of aborting. On a body
 * with one run per slot and no unreadable instants — which is this one, since the
 * pre-hotfix files COMMITTED here rather than aborting — those branches never
 * fire, so the row outcome is the same too.
 *
 * The owner's production box is NOT covered by these entries and does not need to
 * be: `54c7f73`'s own message records that 144 aborted three times there and left
 * no `_migrations` row, so that box applied the AMENDED file and verifies clean.
 */
export const KNOWN_DIVERGENCES: readonly KnownDivergence[] = [
  {
    file: '144_task_runs_absorbed.sql',
    appliedChecksum: '7b58e91a0eb39ede7683c6e95c4ac899266b797b2e141b84d832dbc0fadf2e04',
    fileChecksum: 'a5819f2961555361d4e7d8cac3a1e42873765916c076831d1c643452f15cecd2',
    since: '2026-08-09',
    reason: 'Amended by hotfix 54c7f73 after this box applied it. DDL delta is the hotfix\'s own TEMP tables only (_mig144_cand, _mig144_slot), created and dropped inside the file: the persistent schema is unchanged. The behavioural delta (duplicate-slot runs carried as audit rows, pre-2020 opened_at clamped) has no effect on a body with one run per slot, which is this one — the pre-hotfix file committed here rather than aborting.',
  },
  {
    file: '146_task_log_absorbed.sql',
    appliedChecksum: '171d97a53f8e39d593622aa76af573a2e8a7ed929e3a82aad8689f535c33ca76',
    fileChecksum: '722e59159a2007be43c2212029eabcd77b0af8725d3f5be24862a7f4b8da514e',
    since: '2026-08-09',
    reason: 'Amended by hotfix 54c7f73 after this box applied it. DDL is BYTE-IDENTICAL between the two versions; the amendment only stops an unreadable task_log instant aborting the file, dating the entry at its work row\'s opened_at instead. This box had no unreadable instants (the pre-hotfix file committed here), so no row differs either.',
  },
  {
    file: '135b_stable_work_spine.sql',
    appliedChecksum: '7924a3cbb448798b6ec6ba4a45ca876628126fc8bd88763a961f22ff25dc2370',
    fileChecksum: '0e2be0af69eac0cc1c19226d69d694f46547501b4d0d567a09746c586eeed7f3',
    since: '2026-08-30',
    reason: '3.1.18, UPDATE-INTEGRITY U0: `park_namespace_empty` was demoted from refusal tier to report tier, because it asserted an environmental precondition ("no agent is mid-delegation") that one user\'s box did not meet — and the boot died there, permanently. The applied checksum is the ONE historical version of this file across every published tag (v3.1.17 and v3.1.17-preflight.23..33 all carry blob 862d3ff; measured, not assumed). What changed is one _bridge_assert ROW and its comment: `ok` is now the constant 1 and the count moved into `detail`. _bridge_assert is a TEMP table this file creates and drops, so the PERSISTENT SCHEMA and every row this file writes to a real table are byte-for-byte what a box on the amended file would produce. The only behavioural delta is the one intended: a body with open `park:%` keys no longer aborts. Any box carrying this checksum already crossed the bridge with zero parks, so on that box the two versions are not merely equivalent in schema, they took the identical branch.',
  },
  // ── THE NAMES/PII SCRUB'S THREE, 2026-09-26 — a DIFFERENT and stronger warrant ──────────
  //
  // The three above carry real deltas (temp tables, a refusal tier, which historical rows a rescue
  // carried) and each had to be argued down to "equivalent on this body". These three do not: the
  // scrub edited ONLY `--` comment lines, so the EXECUTABLE SQL IS BYTE-IDENTICAL. Measured, not
  // asserted — strip every line whose first non-space characters are `--` from the applied version
  // and from the file on disk, and hash what is left:
  //
  //     135_work_spine.sql                1b5588eb8d40ec32…  ==  1b5588eb8d40ec32…
  //     159_owed_interrupt_event_kind.sql 4fff758c01f96a6d…  ==  4fff758c01f96a6d…
  //     171_report_read_indexes.sql       6daf355b40767a03…  ==  6daf355b40767a03…
  //
  // and in all three the whole diff is ONE line, and that line starts `--` on both sides. So the
  // recipe did not change: a box that applied the pre-scrub file produced exactly the schema and
  // exactly the rows the current file produces. There is no "equivalent on this body" step.
  //
  // WHY THE EDIT HAPPENED AT ALL, since "never touch an applied migration" is the ordinary rule:
  // migrations are RAW-COPIED into the package (`deploy/build-package.sh:57-58`), so a dev-box agent
  // name inside one genuinely ships to every user's disk, and the owner's rule of 2026-09-26 forbids
  // that. The same legitimate reason will recur, which is why the freeze is now MECHANISED rather
  // than declared: `check-migration-freeze.mjs` fails any commit that touches
  // `db/migrations/**` without adding a matching entry here, because `KNOWN_DIVERGENCES` cannot
  // pre-approve a future edit — amend again and the triple stops matching and the ERROR returns.
  //
  // `appliedChecksum` for 135 is the PRE-SCRUB FILE's checksum rather than a value read from this
  // box: this box's `_migrations` row carries a NULL checksum (applied before the column existed) so
  // it reports `unverifiable`, and the entry exists for the boxes that DID record one. 159 and 171
  // were read from this box and their recorded values ARE the pre-scrub file's checksum, which is
  // what proves those rows were written by the pre-scrub bytes.
  {
    file: '135_work_spine.sql',
    appliedChecksum: '92e5fc365d32bb5b4b3105aee855c62a6834c7f1a55b1e0c1ed9e02515e9ea73',
    fileChecksum: '9e7ad3d7674780361817a863ac45c76da6dedb21e83211cba77924e7e00a9df4',
    since: '2026-09-26',
    reason: 'Names/PII scrub (owner rule 2026-09-26): one comment line, a dev-box agent id in an example of what `created_by` holds, rewritten to \'<agent-id>\'. Executable SQL is BYTE-IDENTICAL with `--` lines stripped (1b5588eb8d40ec32…, both sides), and the entire file diff is that one comment line. Migrations are raw-copied into the package, so the name really did ship. appliedChecksum is the pre-scrub FILE checksum: this box recorded NULL (pre-checksum-column) and this entry is for boxes that recorded one.',
  },
  {
    file: '159_owed_interrupt_event_kind.sql',
    appliedChecksum: 'ebf258ba4f3d66785424c22294f52959a573ef2df75dea8b7422a07498ec7944',
    fileChecksum: 'a655149bf43beecdc0667ba0a855ec3cee75568814e8b2c98cdc66d234399d49',
    since: '2026-09-26',
    reason: 'Names/PII scrub (owner rule 2026-09-26): one comment line naming a dev-box harness agent by UUID, rewritten to \'a harness agent\'. Executable SQL BYTE-IDENTICAL with `--` lines stripped (4fff758c01f96a6d…, both sides); the whole diff is that one comment line. The recorded checksum on the dev box equals the pre-scrub file\'s checksum, which is what proves the row was written by those bytes.',
  },
  {
    file: '171_report_read_indexes.sql',
    appliedChecksum: '7ca4208b4cd4b85a1df92040ab377accc2ba98ddbd13b8c281738e0045951cec',
    fileChecksum: 'ecaffb89ecfcd2fe1157c9a459f49e7098d72b1a889845949941e1afe64a3930',
    since: '2026-09-26',
    reason: 'Names/PII scrub (owner rule 2026-09-26): one comment line naming a dev-box agent, rewritten by role. Executable SQL BYTE-IDENTICAL with `--` lines stripped (6daf355b40767a03…, both sides); the whole diff is that one comment line. Recorded checksum on the dev box equals the pre-scrub file\'s checksum.',
  },
];

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
export function auditMigrationChecksums(
  db: Db,
  read: ReadMigration,
  ledger: readonly KnownDivergence[] = KNOWN_DIVERGENCES,
): MigrationChecksumAudit {
  const audit: MigrationChecksumAudit = { verified: 0, unverifiable: 0, adjudicated: 0, findings: [] };
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
    if (actual === row.checksum) { audit.verified += 1; continue; }
    // The match is on the TRIPLE. An entry that named only the file would silence
    // every future edit of it, which is the thing this must never become.
    const adjudicated = ledger.find(
      d => d.file === row.name && d.appliedChecksum === row.checksum && d.fileChecksum === actual,
    );
    if (adjudicated) audit.adjudicated += 1;
    audit.findings.push({ file: row.name, kind: 'diverged', recorded: row.checksum, actual, ...(adjudicated ? { adjudicated } : {}) });
  }
  return audit;
}

/** The boot-time divergence check: audit, then say it out loud. Never throws — an audit
 *  must not be the reason a box cannot start. */
export function reportMigrationChecksums(db: Db, read: ReadMigration): MigrationChecksumAudit | null {
  try {
    const audit = auditMigrationChecksums(db, read);
    for (const f of audit.findings) {
      if (f.kind === 'diverged' && f.adjudicated) {
        // Examined, with its reason and its date, bound to these exact two
        // hashes. Still SAID on every boot — the fact does not go away — but as
        // news that has already been read rather than as an unanswered alarm.
        logger.info(
          'Migration divergence (examined): this file was amended after this database applied it, and the difference has been diagnosed.',
          { file: f.file, appliedChecksum: f.recorded, fileChecksum: f.actual, since: f.adjudicated.since, reason: f.adjudicated.reason },
        );
      } else if (f.kind === 'diverged') {
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
      diverged: audit.findings.filter(f => f.kind === 'diverged' && !f.adjudicated).length,
      divergedExamined: audit.adjudicated,
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
