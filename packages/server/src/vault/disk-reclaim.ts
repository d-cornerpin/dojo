// Nightly vault-archive disk reclaim, run in the vault maintenance window before the Dreamer wakes.
//   1. Deletes PROCESSED archives fully covered by another PROCESSED archive of the same agent (superset
//      span with >= message_count). Kept: the newest per (earliest_at, latest_at) span, the newest overall,
//      anything referenced by vault_entries provenance, and an agent's only remaining archive. Unprocessed
//      rows (the Dreamer queue) are never touched, neither as delete candidates nor as coverage witnesses.
//   2. If the freelist exceeds ~10% of pages, runs VACUUM, only when no agent turn is active; otherwise
//      it retries the next night.
// VACUUM rewrites the whole file and cannot be safely interrupted, so it is never aborted. It is crash-safe:
// if the process dies mid-VACUUM, SQLite rolls back and the shrink is retried the next night.

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

/** True when no in-process agent turn is running and no agent row claims to be mid-turn (safe for a VACUUM). */
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

/** Nightly entry point: deletes redundant processed archives, then VACUUMs when worthwhile and safe. Synchronous. */
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

  // Delete redundant PROCESSED archives. A metadata temp table keeps the O(n^2) span-coverage check from
  // rescanning the multi-GB messages blob column.
  try {
    db.exec('DROP TABLE IF EXISTS temp._vc_reclaim; DROP TABLE IF EXISTS temp._vc_redundant;');
    db.exec(`
      CREATE TEMP TABLE _vc_reclaim AS
        SELECT id, agent_id, earliest_at, latest_at, message_count, is_processed, created_at, rowid AS rid
          FROM vault_conversations;
      CREATE INDEX _vc_reclaim_agent ON _vc_reclaim(agent_id);
    `);

    // Redundant = processed, and fully covered by another PROCESSED archive of the same agent. The tiebreak is a
    // strict total order, so among identical-span duplicates exactly one (fullest, then newest) survives;
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

    // Keep-set guards (each already implied by the coverage rule, but enforced directly as the contract):
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

  // VACUUM when worthwhile and safe.
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
    // Rough SSD estimate, logged so an operator watching a big first-run cleanup expects the duration.
    const estSecondsLow = Math.max(1, Math.round(fileGB * 5));
    const estSecondsHigh = Math.max(5, Math.round(fileGB * 30));
    logger.warn('Vault disk reclaim: starting VACUUM (this rewrites the whole DB file and cannot be interrupted mid-way; if the process dies, SQLite rolls back and the shrink is retried next night)', {
      fileSizeGB: Number(fileGB.toFixed(2)),
      freelistPages: freelist,
      expectedDurationSeconds: `${estSecondsLow}-${estSecondsHigh}`,
    });

    const activityId = `maintenance_vacuum_${Date.now()}`;
    const startedAt = new Date().toISOString();
    // Reuses the 'compaction' kind so no dashboard/shared type changes are needed.
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
