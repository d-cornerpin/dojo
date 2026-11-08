// ════════════════════════════════════════════════════════════════════════════
// The database rows the Dojo's two standard models carry; `ollama-upkeep.ts` writes them after each look at what
// Ollama lists.
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';

/** The `models` row for `tag` on the provider: made, or repaired and re-enabled when discovery made it first. */
export function registerStandardRow(providerId: string, tag: string, capabilities: string[], info: { contextWindow: number | null; maxOutputTokens: number | null } | null): string {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM models WHERE provider_id = ? AND api_model_id = ?').get(providerId, tag) as { id: string } | undefined;
  if (existing) {
    // A row discovery made first carries no `decision` capability; the pair is hard-wired, so
    // its capability is repaired and it is re-enabled even if a person disabled it.
    db.prepare("UPDATE models SET is_enabled = 1, capabilities = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(capabilities), existing.id);
    return existing.id;
  }
  const id = `ollama-${tag.replace(/[^a-z0-9]/gi, '-')}`;
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, input_cost_per_m, output_cost_per_m, is_enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 1, datetime('now'), datetime('now'))
  `).run(id, providerId, tag, tag, JSON.stringify(capabilities), info?.contextWindow ?? null, info?.maxOutputTokens ?? null);   // M41: what Ollama did not report is stored as not set
  return id;
}

/** The assignments the pair carries. The writer owns the `system` tier outright. The summary writer is never
 *  set here: each agent's own model writes its summaries. */
export function assignStandard(writerId: string | null, decisionId: string | null): void {
  const db = getDb();
  const upsert = db.prepare(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`);
  db.transaction(() => {
    if (writerId) {
      db.prepare('DELETE FROM router_tier_models WHERE tier_id = ?').run('system');
      db.prepare('INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES (?, ?, 0)').run('system', writerId);
    }
    if (decisionId) upsert.run('decision_model_id', decisionId);
  })();
}

/** The DECISION model is not installed: a row registered for it without the model is disabled (it then reads as absent and
 *  every judgment keeps its rule), and so is `decision_model_id`; the next upkeep that pulls it re-enables the row. Only the
 *  decision row: the writer's row may be an agent's model, and a failed download of it says nothing about that. */
export function unregisterStandardRow(providerId: string, tag: string): void {
  const db = getDb();
  const row = db.prepare(`SELECT id FROM models WHERE provider_id = ? AND api_model_id = ? AND is_enabled = 1 AND capabilities LIKE '%"decision"%'`).get(providerId, tag) as { id: string } | undefined;
  if (!row) return;
  db.prepare("UPDATE models SET is_enabled = 0, updated_at = datetime('now') WHERE id = ?").run(row.id);
  db.prepare("DELETE FROM config WHERE key = 'decision_model_id' AND value = ?").run(row.id);
}
