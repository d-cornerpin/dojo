// ════════════════════════════════════════
// The cross-agent tool-error ledger (K37; migration 206): one row per (tool, fingerprint) with
// hits, the distinct agents, and a sample. Written on every failing tool result by
// `recordToolOutcome`; read by the Healer's "recurring tool errors" section. Best-effort: a
// recording fault never reaches the turn.
// ════════════════════════════════════════

import { getDb } from '../../db/connection.js';
import { FINGERPRINT_CHARS, canonicalToolName, fingerprint } from './error-fingerprint.js';

export function noteToolError(agentId: string, toolName: string, errorText: string | null | undefined): void {
  if (!errorText) return;
  try {
    const db = getDb();
    const tool = canonicalToolName(toolName);
    const fp = fingerprint(toolName, errorText);
    const now = Date.now();
    db.transaction(() => {
      const row = db.prepare('SELECT agents FROM tool_error_signatures WHERE tool = ? AND fingerprint = ?')
        .get(tool, fp) as { agents: string } | undefined;
      if (!row) {
        db.prepare(
          'INSERT INTO tool_error_signatures (tool, fingerprint, sample, first_at, last_at, hits, agents) VALUES (?, ?, ?, ?, ?, 1, ?)',
        ).run(tool, fp, errorText.slice(0, FINGERPRINT_CHARS), now, now, JSON.stringify([agentId]));
        return;
      }
      const agents = JSON.parse(row.agents) as string[];
      if (!agents.includes(agentId)) agents.push(agentId);
      db.prepare('UPDATE tool_error_signatures SET hits = hits + 1, last_at = ?, agents = ? WHERE tool = ? AND fingerprint = ?')
        .run(now, JSON.stringify(agents), tool, fp);
    })();
  } catch { /* recording is best-effort */ }
}
