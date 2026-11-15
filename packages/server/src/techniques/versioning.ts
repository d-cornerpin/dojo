// Technique versioning: disk snapshots.

import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';

const logger = createLogger('technique-versioning');

// Every TECHNIQUE.md update writes a copy under a versions/ subdirectory of the technique, so the Trainer
// can read prior versions with file_read alongside the DB `technique_versions` table.

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
 * does NOT block the DB-side version row from being written. Returns
 * whether both files actually landed on disk.
 */
export function writeDiskVersionSnapshot(
  techniqueDir: string,
  versionNumber: number,
  content: string,
  meta: { changedBy: string | null; changeSummary: string | null; createdAt: string },
): boolean {
  try {
    const dir = versionsDir(techniqueDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(versionFilePath(techniqueDir, versionNumber), content, 'utf-8');
    fs.writeFileSync(
      versionMetaPath(techniqueDir, versionNumber),
      JSON.stringify({ versionNumber, ...meta }, null, 2),
      'utf-8',
    );
    return true;
  } catch (err) {
    logger.warn('Failed to write disk version snapshot', {
      techniqueDir, versionNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
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

/**
 * Backfill disk version snapshots for a technique that has none yet: writes TECHNIQUE_v{N}.md (+ sidecar)
 * from the DB version rows. No-op if any disk version exists, so it cannot clobber a partial history.
 * Returns the number of snapshots written.
 */
export function backfillDiskVersionsFromDb(techniqueId: string, techniqueDir: string): number {
  const dir = versionsDir(techniqueDir);
  // existsSync alone is not enough: a plain file at the versions path holds
  // no snapshot and makes readdirSync throw. Skip the check there and let
  // the write below fail and report itself.
  let isVersionsDir = false;
  try { isVersionsDir = fs.statSync(dir).isDirectory(); } catch { /* missing */ }
  if (isVersionsDir) {
    // Already has any disk version → assume this technique is on the
    // forward path and don't risk overwriting more recent work.
    const existing = fs.readdirSync(dir).some(n => /^TECHNIQUE_v\d+\.md$/.test(n));
    if (existing) return 0;
  }
  const versions = getVersions(techniqueId);
  if (versions.length === 0) return 0;
  let written = 0;
  for (const v of versions) {
    if (writeDiskVersionSnapshot(techniqueDir, v.versionNumber, v.techniqueMd, {
      changedBy: v.changedBy,
      changeSummary: v.changeSummary,
      createdAt: v.createdAt,
    })) written++;
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
