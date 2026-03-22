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
  db.prepare(`
    INSERT INTO technique_versions (id, technique_id, version_number, technique_md, changed_by, change_summary, files_snapshot, created_at)
    VALUES (?, ?, ?, ?, 'system', ?, ?, datetime('now'))
  `).run(
    uuidv4(), techniqueId, newVersion, version.techniqueMd,
    `Restored from version ${version.versionNumber}`,
    JSON.stringify(filesSnapshot),
  );

  logger.info('Technique version restored', { techniqueId, restoredFrom: version.versionNumber, newVersion });
  return true;
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
