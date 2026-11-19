// The database rows the Dojo's two standard models carry, written after each look at what Ollama lists.

import { getDb } from '../db/connection.js';
import { setConfigValue } from '../config/config-value.js';

/** The `models` row for `tag` on the provider: made, or repaired and re-enabled when discovery made it first. */
export function registerStandardRow(providerId: string, tag: string, capabilities: string[], info: { contextWindow: number | null; maxOutputTokens: number | null } | null): string {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM models WHERE provider_id = ? AND api_model_id = ?').get(providerId, tag) as { id: string } | undefined;
  if (existing) {
    // A row discovery made first lacks the `decision` capability: repair it, and re-enable it even if disabled.
    db.prepare("UPDATE models SET is_enabled = 1, capabilities = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(capabilities), existing.id);
    return existing.id;
  }
  const id = `ollama-${tag.replace(/[^a-z0-9]/gi, '-')}`;
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, input_cost_per_m, output_cost_per_m, is_enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 1, datetime('now'), datetime('now'))
  `).run(id, providerId, tag, tag, JSON.stringify(capabilities), info?.contextWindow ?? null, info?.maxOutputTokens ?? null);   // what Ollama did not report is stored as not set
  return id;
}

/** The writer owns the `system` tier outright; the summary writer is never set here (each agent's own model does). */
export function assignStandard(writerId: string | null, decisionId: string | null): void {
  const db = getDb();
  db.transaction(() => {
    if (writerId) {
      db.prepare('DELETE FROM router_tier_models WHERE tier_id = ?').run('system');
      db.prepare('INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES (?, ?, 0)').run('system', writerId);
    }
    if (decisionId) setConfigValue('decision_model_id', decisionId);
  })();
}

/** The DECISION model is not installed: disable its row (it reads as absent) and `decision_model_id`.
 *  Decision row only: the writer's row may be an agent's model, which a failed download says nothing about. */
export function unregisterStandardRow(providerId: string, tag: string): void {
  const db = getDb();
  const row = db.prepare(`SELECT id FROM models WHERE provider_id = ? AND api_model_id = ? AND is_enabled = 1 AND capabilities LIKE '%"decision"%'`).get(providerId, tag) as { id: string } | undefined;
  if (!row) return;
  db.prepare("UPDATE models SET is_enabled = 0, updated_at = datetime('now') WHERE id = ?").run(row.id);
  db.prepare("DELETE FROM config WHERE key = 'decision_model_id' AND value = ?").run(row.id);
}
