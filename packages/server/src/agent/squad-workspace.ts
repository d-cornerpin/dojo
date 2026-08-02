// ════════════════════════════════════════════════════════════════════════════
// SQUAD WORKSPACE ACCESS — a leaf (PHASE-5 T2).
//
// Extracted verbatim from `agent/permissions.ts`. When an agent belongs to a
// group (squad) that is BUILDING a technique, it is automatically granted
// file_read and file_write inside that technique's directory. This is the one
// allow that is not on the manifest, which is exactly why it needed the global
// deny re-applied around it (FA-P5) — a requirement the fs broker now expresses
// structurally instead of by remembering.
// ════════════════════════════════════════════════════════════════════════════

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

  // FA-P5: canonicalize BOTH sides exactly as the main file check does
  // (canonicalizeAgentPath = path.resolve(expandTilde), which collapses '..' and
  // resolves a relative path to absolute). The old expandTilde + startsWith left a
  // squad member using a relative or '..'-form path inside its OWN technique dir
  // wrongly denied, because the un-normalized string did not match the (also
  // un-normalized) dir even though the main file check had already normalized the
  // same path. NOTE: path.resolve is LEXICAL, it does not follow symlinks, which
  // matches canonicalizeAgentPath's own semantics, so this stays consistent with
  // the main check rather than introducing a new resolution mode. Compare on a
  // path-segment boundary so /a/b matches /a/b/file but not a sibling /a/bc.
  const canonicalPath = foldPath(canonicalizeAgentPath(filePath));
  const canonicalDir = foldPath(canonicalizeAgentPath(technique.directory_path));
  return canonicalPath === canonicalDir || canonicalPath.startsWith(canonicalDir + path.sep);
}
