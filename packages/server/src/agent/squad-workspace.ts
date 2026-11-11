// SQUAD WORKSPACE ACCESS: an agent whose group is BUILDING a technique is granted file_read
// and file_write inside that technique's directory, the one allow not on the manifest.

import path from 'node:path';
import { getDb } from '../db/connection.js';
import { foldPath } from './fs-case.js';
import { canonicalizeAgentPath } from './path-resolve.js';

export function hasSquadWorkspaceAccess(agentId: string, filePath: string): boolean {
  const db = getDb();
  const agent = db.prepare('SELECT group_id FROM agents WHERE id = ?').get(agentId) as { group_id: string | null } | undefined;
  if (!agent?.group_id) return false;

  const technique = db.prepare(`
    SELECT directory_path FROM techniques
    WHERE build_squad_id = ? AND state IN ('draft', 'review')
  `).get(agent.group_id) as { directory_path: string } | undefined;

  if (!technique) return false;

  // Both sides canonicalized as the main file check (lexical, no symlinks); /a/b matches /a/b/file, not /a/bc.
  const canonicalPath = foldPath(canonicalizeAgentPath(filePath));
  const canonicalDir = foldPath(canonicalizeAgentPath(technique.directory_path));
  return canonicalPath === canonicalDir || canonicalPath.startsWith(canonicalDir + path.sep);
}
