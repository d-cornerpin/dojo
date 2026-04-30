// ════════════════════════════════════════
// Technique Versioning — Snapshots & Restore
// ════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { getTechnique } from './store.js';

const logger = createLogger('technique-versioning');

// ── Disk-based version snapshots ──
//
// Every TECHNIQUE.md update writes a copy to a versions/ subdirectory of
// the technique. This gives the Trainer (and the user) a browsable
// on-disk history alongside the DB-backed `technique_versions` table.
// Pre-2026-04-30 the only version history was in SQLite, which the
// Trainer couldn't reach via file_read — meaning agents had no way to
// look at a prior version for context or restore reasoning.

export const VERSIONS_SUBDIR = 'versions';

export function versionsDir(techniqueDir: string): string {
  return path.join(techniqueDir, VERSIONS_SUBDIR);
}

export function versionFilePath(techniqueDir: string, versionNumber: number): string {
  return path.join(versionsDir(techniqueDir), `TECHNIQUE_v${versionNumber}.md`);
}

export function versionMetaPath(techniqueDir: string, versionNumber: number): string {
  return path.join(versionsDir(techniqueDir), `TECHNIQUE_v${versionNumber}.json`);
}

/**
 * Write a snapshot of a technique's TECHNIQUE.md content to disk so the
 * Trainer can reach it via file_read later. Best-effort: failure here
 * does NOT block the DB-side version row from being written.
 */
export function writeDiskVersionSnapshot(
  techniqueDir: string,
  versionNumber: number,
  content: string,
  meta: { changedBy: string | null; changeSummary: string | null; createdAt: string },
): void {
  try {
    const dir = versionsDir(techniqueDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(versionFilePath(techniqueDir, versionNumber), content, 'utf-8');
    fs.writeFileSync(
      versionMetaPath(techniqueDir, versionNumber),
      JSON.stringify({ versionNumber, ...meta }, null, 2),
      'utf-8',
    );
  } catch (err) {
    logger.warn('Failed to write disk version snapshot', {
      techniqueDir, versionNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface TechniqueVersion {
  id: string;
  techniqueId: string;
  versionNumber: number;
  techniqueMd: string;
  changedBy: string | null;
  changeSummary: string | null;
  filesSnapshot: Array<{ path: string; size: number }>;
  createdAt: string;
}

export function getVersions(techniqueId: string): TechniqueVersion[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM technique_versions WHERE technique_id = ? ORDER BY version_number DESC
  `).all(techniqueId) as Array<Record<string, unknown>>;

  return rows.map(rowToVersion);
}

export function getVersion(versionId: string): TechniqueVersion | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM technique_versions WHERE id = ?').get(versionId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToVersion(row);
}

export function restoreVersion(techniqueId: string, versionId: string): boolean {
  const version = getVersion(versionId);
  if (!version || version.techniqueId !== techniqueId) return false;

  const technique = getTechnique(techniqueId);
  if (!technique) return false;

  // Write the old TECHNIQUE.md content
  const mdPath = path.join(technique.directoryPath, 'TECHNIQUE.md');
  fs.writeFileSync(mdPath, version.techniqueMd, 'utf-8');

  // Increment version and create a new snapshot recording the restore
  const db = getDb();
  const newVersion = technique.version + 1;
  db.prepare("UPDATE techniques SET version = ?, updated_at = datetime('now') WHERE id = ?").run(newVersion, techniqueId);

  const filesSnapshot = version.filesSnapshot;
  const changeSummary = `Restored from version ${version.versionNumber}`;
  const createdAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO technique_versions (id, technique_id, version_number, technique_md, changed_by, change_summary, files_snapshot, created_at)
    VALUES (?, ?, ?, ?, 'system', ?, ?, datetime('now'))
  `).run(
    uuidv4(), techniqueId, newVersion, version.techniqueMd,
    changeSummary,
    JSON.stringify(filesSnapshot),
  );

  // Disk snapshot for the new (restored) version so the file history is
  // continuous: versions/TECHNIQUE_v{newVersion}.md will match the restored content.
  writeDiskVersionSnapshot(technique.directoryPath, newVersion, version.techniqueMd, {
    changedBy: 'system',
    changeSummary,
    createdAt,
  });

  logger.info('Technique version restored', { techniqueId, restoredFrom: version.versionNumber, newVersion });
  return true;
}

/**
 * Backfill disk version snapshots for a technique that pre-dates v1.15.97.
 * Reads the DB-side version rows and writes a TECHNIQUE_v{N}.md (+ sidecar)
 * for each one. No-op if any disk versions already exist (so this can't
 * clobber a partially-written disk history). Returns the number of
 * snapshots written.
 */
export function backfillDiskVersionsFromDb(techniqueId: string, techniqueDir: string): number {
  const dir = versionsDir(techniqueDir);
  if (fs.existsSync(dir)) {
    // Already has any disk version → assume this technique is on the
    // forward path and don't risk overwriting more recent work.
    const existing = fs.readdirSync(dir).some(n => /^TECHNIQUE_v\d+\.md$/.test(n));
    if (existing) return 0;
  }
  const versions = getVersions(techniqueId);
  if (versions.length === 0) return 0;
  let written = 0;
  for (const v of versions) {
    writeDiskVersionSnapshot(techniqueDir, v.versionNumber, v.techniqueMd, {
      changedBy: v.changedBy,
      changeSummary: v.changeSummary,
      createdAt: v.createdAt,
    });
    written++;
  }
  if (written > 0) {
    logger.info('Backfilled disk version snapshots from DB', { techniqueId, written });
  }
  return written;
}

/**
 * List every disk-based version snapshot for a technique. Each entry
 * pairs the disk path the Trainer can `file_read` with the metadata
 * recorded at write time. Falls back to scanning files only when no
 * matching .json sidecar exists.
 */
export function listDiskVersions(techniqueDir: string): Array<{
  versionNumber: number;
  filePath: string;
  metaPath: string;
  changedBy: string | null;
  changeSummary: string | null;
  createdAt: string | null;
  sizeBytes: number;
}> {
  const dir = versionsDir(techniqueDir);
  if (!fs.existsSync(dir)) return [];
  const entries: Array<{ versionNumber: number; filePath: string; metaPath: string; changedBy: string | null; changeSummary: string | null; createdAt: string | null; sizeBytes: number }> = [];
  for (const name of fs.readdirSync(dir)) {
    const m = /^TECHNIQUE_v(\d+)\.md$/.exec(name);
    if (!m) continue;
    const versionNumber = parseInt(m[1], 10);
    const filePath = path.join(dir, name);
    const metaPath = path.join(dir, `TECHNIQUE_v${versionNumber}.json`);
    let changedBy: string | null = null;
    let changeSummary: string | null = null;
    let createdAt: string | null = null;
    try {
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as { changedBy?: string; changeSummary?: string; createdAt?: string };
        changedBy = meta.changedBy ?? null;
        changeSummary = meta.changeSummary ?? null;
        createdAt = meta.createdAt ?? null;
      }
    } catch { /* ignore corrupt sidecar */ }
    let sizeBytes = 0;
    try { sizeBytes = fs.statSync(filePath).size; } catch { /* ignore */ }
    entries.push({ versionNumber, filePath, metaPath, changedBy, changeSummary, createdAt, sizeBytes });
  }
  entries.sort((a, b) => b.versionNumber - a.versionNumber);
  return entries;
}

export function getUsage(techniqueId: string): Array<{
  id: string;
  agentId: string;
  agentName: string | null;
  usedAt: string;
  success: boolean | null;
  notes: string | null;
}> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM technique_usage WHERE technique_id = ? ORDER BY used_at DESC LIMIT 100
  `).all(techniqueId) as Array<Record<string, unknown>>;

  return rows.map(row => ({
    id: row.id as string,
    agentId: row.agent_id as string,
    agentName: row.agent_name as string | null,
    usedAt: row.used_at as string,
    success: row.success === null ? null : Boolean(row.success),
    notes: row.notes as string | null,
  }));
}

function rowToVersion(row: Record<string, unknown>): TechniqueVersion {
  let filesSnapshot: Array<{ path: string; size: number }> = [];
  try {
    filesSnapshot = JSON.parse((row.files_snapshot as string) || '[]');
  } catch { /* skip */ }

  return {
    id: row.id as string,
    techniqueId: row.technique_id as string,
    versionNumber: row.version_number as number,
    techniqueMd: row.technique_md as string,
    changedBy: row.changed_by as string | null,
    changeSummary: row.change_summary as string | null,
    filesSnapshot,
    createdAt: row.created_at as string,
  };
}
