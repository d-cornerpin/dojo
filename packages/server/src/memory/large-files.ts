// ════════════════════════════════════════
// The read door for stored large files.
// ════════════════════════════════════════
//
// v1's interception machinery — the threshold check, the type sniffing, the
// summary generators, the store-and-stub write — lost its last caller and is
// gone. This file now only reads a stored large file back from disk.

import * as effectFs from '../agent/effects/fs.js';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';

const logger = createLogger('memory-large-files');

// ── Retrieve ──

export function getLargeFile(fileId: string): { content: string; metadata: Record<string, unknown> } | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM large_files WHERE id = ?').get(fileId) as {
    id: string;
    agent_id: string;
    original_path: string | null;
    mime_type: string | null;
    token_count: number;
    exploration_summary: string;
    storage_path: string;
    created_at: string;
  } | undefined;

  if (!row) return null;

  try {
    const content = effectFs.readFileSync(row.storage_path, 'utf-8');
    return {
      content,
      metadata: {
        id: row.id,
        agentId: row.agent_id,
        originalPath: row.original_path,
        mimeType: row.mime_type,
        tokenCount: row.token_count,
        explorationSummary: row.exploration_summary,
        storagePath: row.storage_path,
        createdAt: row.created_at,
      },
    };
  } catch (err) {
    logger.error('Failed to read large file from disk', {
      fileId,
      storagePath: row.storage_path,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
