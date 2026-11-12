// Cross-agent tool-error ledger: one row per (tool, fingerprint) with hits, agents and a masked sample.
// Written by `recordToolOutcome` on each failed result; read by healer/recurring-tool-errors.ts.

import { getDb } from '../../db/connection.js';
import { redactHandedCredentials } from '../../credentials/secret-values.js';
import { FINGERPRINT_CHARS, canonicalToolName, fingerprint, maskVolatile } from './error-fingerprint.js';

export function noteToolError(agentId: string, toolName: string, errorText: string | null | undefined): void {
  if (!errorText) return;
  try {
    const db = getDb();
    // Nothing identifying is stored: handled credentials are redacted, then the fingerprint masks apply.
    const text = redactHandedCredentials(agentId, errorText);
    const tool = canonicalToolName(toolName);
    const fp = fingerprint(toolName, text);
    const now = Date.now();
    db.transaction(() => {
      const row = db.prepare('SELECT agents FROM tool_error_signatures WHERE tool = ? AND fingerprint = ?')
        .get(tool, fp) as { agents: string } | undefined;
      if (!row) {
        db.prepare(
          'INSERT INTO tool_error_signatures (tool, fingerprint, sample, first_at, last_at, hits, agents) VALUES (?, ?, ?, ?, ?, 1, ?)',
        ).run(tool, fp, maskVolatile(toolName, text).slice(0, FINGERPRINT_CHARS), now, now, JSON.stringify([agentId]));
        return;
      }
      const agents = JSON.parse(row.agents) as string[];
      if (!agents.includes(agentId)) agents.push(agentId);
      db.prepare('UPDATE tool_error_signatures SET hits = hits + 1, last_at = ?, agents = ? WHERE tool = ? AND fingerprint = ?')
        .run(now, JSON.stringify(agents), tool, fp);
    })();
  } catch { /* recording is best-effort */ }
}
