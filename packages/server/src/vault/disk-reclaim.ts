// ════════════════════════════════════════════════════════════════════════
// Nightly vault-archive disk reclaim (D1 follow-up, owner chose automatic)
//
// The archive high-water fix (vault/archive.ts) stopped NEW duplicate
// archives, and migration 079 cleared the redundant UNPROCESSED backlog.
// What remained on upgraded installs was the legacy stock of PROCESSED
// nested full-history archives (~6 GB on the reference DB): every pre-fix
// session reset re-copied the agent's entire history, so the processed set
// is hundreds of blobs each fully contained in a newer, larger one.
//
// This job runs nightly inside the vault maintenance window (BEFORE the
// Dreamer wakes, so the box is idle) and:
//   1. deletes PROCESSED archives that are redundant: fully covered by
//      another PROCESSED archive of the same agent (superset span with >=
//      message_count). Keep-set per agent: the newest processed archive per
//      (earliest_at, latest_at) span, always the newest processed archive
//      overall, anything referenced by vault_entries provenance, and never
//      an agent's only remaining archive. Unprocessed rows (the Dreamer
//      queue) are never touched, neither as delete candidates nor as
//      coverage witnesses.
//   2. if the freelist says the reclaim is significant (> ~10% of pages),
//      runs VACUUM, but only when no agent turn is active. If the box is
//      busy the VACUUM is skipped and retried the next night.
//
// VACUUM notes (first-run safety): on a fresh update with ~6 GB of legacy
// archives the first night does the big cleanup. The DELETE itself is fast
// (metadata temp table + PK lookups, ~2 s even at 700+ archives). VACUUM
// rewrites the whole file and CANNOT be safely interrupted mid-way, there
// is no partial-progress mode; we therefore never try to abort it. It IS
// crash-safe: if the process dies during VACUUM, SQLite rolls back and the
// file is simply not shrunk (retried the next night). Expected duration is
// logged before starting, based on the current file size.
// ════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { activeRuns } from '../agent/shared-state.js';

const logger = createLogger('vault-disk-reclaim');

/** Run VACUUM only when freed pages exceed this share of the file. */
const VACUUM_FREELIST_RATIO = 0.10;

export interface DiskReclaimResult {
  deletedArchives: number;
  bytesFreed: number;
  agentsAffected: number;
  vacuumed: boolean;
  vacuumSkippedReason: string | null;
  fileBytesBefore: number;
  fileBytesAfter: number;
}

/** True when it is safe to take the DB offline-ish for a VACUUM: no in-process
 *  agent turn is running and no agent row claims to be mid-turn. */
export function isPlatformIdleForVacuum(): { idle: boolean; reason: string | null } {
  if (activeRuns.size > 0) {
    return { idle: false, reason: `${activeRuns.size} in-process agent run(s) active` };
  }
  const db = getDb();
  const working = (db.prepare("SELECT COUNT(*) AS c FROM agents WHERE status = 'working'").get() as { c: number }).c;
  if (working > 0) {
    return { idle: false, reason: `${working} agent(s) in status 'working'` };
  }
  return { idle: true, reason: null };
}

/**
 * Nightly entry point. Deletes redundant processed archives, then VACUUMs
 * when worthwhile and safe. Synchronous by design (better-sqlite3): it runs
 * in the maintenance window before any agent work is kicked off.
 */
export function reclaimVaultArchiveSpace(): DiskReclaimResult {
  const db = getDb();
  const pageSize = db.pragma('page_size', { simple: true }) as number;
  const fileBytesBefore = (db.pragma('page_count', { simple: true }) as number) * pageSize;

  const result: DiskReclaimResult = {
    deletedArchives: 0,
    bytesFreed: 0,
    agentsAffected: 0,
    vacuumed: false,
    vacuumSkippedReason: null,
    fileBytesBefore,
    fileBytesAfter: fileBytesBefore,
  };

  // ── Phase 1: delete redundant PROCESSED archives ──
  //
  // Metadata temp table so the O(n^2) span-coverage check never rescans the
  // multi-GB messages blob column (same technique migration 079 proved out).
  try {
    db.exec('DROP TABLE IF EXISTS temp._vc_reclaim; DROP TABLE IF EXISTS temp._vc_redundant;');
    db.exec(`
      CREATE TEMP TABLE _vc_reclaim AS
        SELECT id, agent_id, earliest_at, latest_at, message_count, is_processed, created_at, rowid AS rid
          FROM vault_conversations;
      CREATE INDEX _vc_reclaim_agent ON _vc_reclaim(agent_id);
    `);

    // Redundant = processed, and fully covered by another PROCESSED archive of
    // the same agent. The tiebreak is a strict total order so that among
    // identical-span duplicates exactly one row (fullest, then newest) survives;
    // coverage is transitive, so every deleted row is covered by a SURVIVOR.
    db.exec(`
      CREATE TEMP TABLE _vc_redundant AS
        SELECT v.id FROM _vc_reclaim v
         WHERE v.is_processed = 1
           AND EXISTS (
             SELECT 1 FROM _vc_reclaim w
              WHERE w.agent_id = v.agent_id
                AND w.is_processed = 1
                AND w.id <> v.id
                AND w.earliest_at <= v.earliest_at
                AND w.latest_at   >= v.latest_at
                AND w.message_count >= v.message_count
                AND (
                  w.message_count > v.message_count
                  OR w.created_at > v.created_at
                  OR (w.created_at = v.created_at AND w.rid > v.rid)
                )
           );
    `);

    // Keep-set guards (belt and braces; each is provably already excluded by
    // the coverage rule above, but they are the contract, so enforce directly):
    // (a) the newest processed archive overall per agent is never deleted;
    db.exec(`
      DELETE FROM _vc_redundant WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY created_at DESC, rid DESC) AS rn
            FROM _vc_reclaim WHERE is_processed = 1
        ) WHERE rn = 1
      );
    `);
    // (b) provenance: archives referenced by vault entries are never deleted;
    db.exec(`
      DELETE FROM _vc_redundant WHERE id IN (
        SELECT source_conversation_id FROM vault_entries WHERE source_conversation_id IS NOT NULL
      );
    `);
    // (c) never leave an agent that had archives with zero: if deleting this
    //     agent's marked rows would remove ALL its rows, unmark them all.
    db.exec(`
      DELETE FROM _vc_redundant WHERE id IN (
        SELECT r.id FROM _vc_redundant r
        JOIN _vc_reclaim v ON v.id = r.id
        WHERE v.agent_id IN (
          SELECT agent_id FROM _vc_reclaim
          GROUP BY agent_id
          HAVING COUNT(*) = SUM(CASE WHEN id IN (SELECT id FROM _vc_redundant) THEN 1 ELSE 0 END)
        )
      );
    `);

    const stats = db.prepare(`
      SELECT COUNT(*) AS rows, COUNT(DISTINCT vc.agent_id) AS agents, COALESCE(SUM(length(vc.messages)), 0) AS bytes
        FROM vault_conversations vc
       WHERE vc.id IN (SELECT id FROM _vc_redundant)
    `).get() as { rows: number; agents: number; bytes: number };

    if (stats.rows > 0) {
      const del = db.prepare('DELETE FROM vault_conversations WHERE id IN (SELECT id FROM _vc_redundant)').run();
      result.deletedArchives = del.changes;
      result.bytesFreed = stats.bytes;
      result.agentsAffected = stats.agents;
      logger.info('Vault disk reclaim: deleted redundant processed archives', {
        deleted: del.changes,
        agents: stats.agents,
        approxBytesFreed: stats.bytes,
        approxMBFreed: Math.round(stats.bytes / (1024 * 1024)),
      });
    } else {
      logger.info('Vault disk reclaim: no redundant processed archives found');
    }

    db.exec('DROP TABLE IF EXISTS temp._vc_reclaim; DROP TABLE IF EXISTS temp._vc_redundant;');
  } catch (err) {
    try { db.exec('DROP TABLE IF EXISTS temp._vc_reclaim; DROP TABLE IF EXISTS temp._vc_redundant;'); } catch { /* ignore */ }
    logger.error('Vault disk reclaim: archive dedup failed (VACUUM check still runs)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ── Phase 2: VACUUM when worthwhile and safe ──
  try {
    const pageCount = db.pragma('page_count', { simple: true }) as number;
    const freelist = db.pragma('freelist_count', { simple: true }) as number;
    const freelistRatio = pageCount > 0 ? freelist / pageCount : 0;

    if (freelistRatio <= VACUUM_FREELIST_RATIO) {
      result.vacuumSkippedReason = `freelist ${(freelistRatio * 100).toFixed(1)}% of pages (threshold ${VACUUM_FREELIST_RATIO * 100}%)`;
      logger.info('Vault disk reclaim: VACUUM not needed', { freelist, pageCount, ratio: freelistRatio });
      return result;
    }

    const idleCheck = isPlatformIdleForVacuum();
    if (!idleCheck.idle) {
      result.vacuumSkippedReason = `platform busy: ${idleCheck.reason}`;
      logger.warn('Vault disk reclaim: VACUUM needed but skipped (platform busy), retrying next night', {
        reason: idleCheck.reason, freelist, pageCount,
      });
      return result;
    }

    const fileGB = (pageCount * pageSize) / (1024 * 1024 * 1024);
    // Rough SSD estimate; the point is an order-of-magnitude expectation in
    // the log so an operator watching a big first-run cleanup is not alarmed.
    const estSecondsLow = Math.max(1, Math.round(fileGB * 5));
    const estSecondsHigh = Math.max(5, Math.round(fileGB * 30));
    logger.warn('Vault disk reclaim: starting VACUUM (this rewrites the whole DB file and cannot be interrupted mid-way; if the process dies, SQLite rolls back and the shrink is retried next night)', {
      fileSizeGB: Number(fileGB.toFixed(2)),
      freelistPages: freelist,
      expectedDurationSeconds: `${estSecondsLow}-${estSecondsHigh}`,
    });

    const activityId = `maintenance_vacuum_${Date.now()}`;
    const startedAt = new Date().toISOString();
    // Rendered by ActiveJobsIndicator as an engine-managed row (no Stop
    // button). Reuses the 'compaction' kind so no dashboard/shared type
    // changes are needed; the label carries the real meaning.
    broadcast({
      type: 'engine:activity',
      data: { id: activityId, kind: 'compaction', agentId: null, label: 'Nightly maintenance: reclaiming disk space', startedAt, phase: 'start' },
    });

    const t0 = Date.now();
    try {
      db.exec('VACUUM');
      // Fold the WAL back into the main file and truncate it, so the on-disk
      // footprint after the nightly shrink is the real one.
      try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
      const afterPages = db.pragma('page_count', { simple: true }) as number;
      result.fileBytesAfter = afterPages * pageSize;
      result.vacuumed = true;
      logger.warn('Vault disk reclaim: VACUUM complete', {
        seconds: Math.round((Date.now() - t0) / 1000),
        fileSizeBeforeMB: Math.round(fileBytesBefore / (1024 * 1024)),
        fileSizeAfterMB: Math.round(result.fileBytesAfter / (1024 * 1024)),
        reclaimedMB: Math.round((fileBytesBefore - result.fileBytesAfter) / (1024 * 1024)),
      });
    } finally {
      broadcast({
        type: 'engine:activity',
        data: { id: activityId, kind: 'compaction', agentId: null, label: 'Nightly maintenance: reclaiming disk space', startedAt, phase: 'end' },
      });
    }
  } catch (err) {
    result.vacuumSkippedReason = `VACUUM failed: ${err instanceof Error ? err.message : String(err)}`;
    logger.error('Vault disk reclaim: VACUUM failed (will retry next night)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}
