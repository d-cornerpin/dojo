// ════════════════════════════════════════════════════════════════════════════════════════
// THE CONFIGURATION AND HEALTH OF THE PLATFORM, AS ONE PAGE.
//
// What the dashboard spreads over several tabs, read live on the read-only connection: the
// running version, every agent, the providers and their models, the router's tiers, the models
// platform jobs use, what is scheduled next, budgets, integration switches, every other
// setting, the Ollama lock, and the latest Healer diagnostic. Every row passes
// `redactRows` first, so a key in a setting or a password in a provider URL is blanked; the
// credential tables are never read. Each line names an id so `sql` can follow it up.
// ════════════════════════════════════════════════════════════════════════════════════════

import type Database from 'better-sqlite3';
import { getReadOnlyDb } from '../db/connection.js';
import { getOllamaLock } from '../services/ollama-lock.js';
import { redactRows, redactText } from './redact.js';
import { agentLabel, agentNames, short, toMs, utc } from './scope.js';
import { pointerLine, sourceRef } from './source-remote.js';

export const STATE_SECTIONS = ['Version', 'Agents', 'Providers and models', 'Router tiers', 'Models for platform jobs', 'Schedules',
  'Budgets', 'Integrations and switches', 'Settings', 'Ollama', 'Healer diagnostics'] as const;

type Row = Record<string, unknown>;
const rows = (db: Database.Database, q: string, ...args: unknown[]): Row[] => redactRows(db.prepare(q).all(...args) as Row[]);
const or = (lines: string[], none: string): string => (lines.length ? lines.join('\n') : none);
const MODEL_KEY = /model/i;
const SWITCH_KEY = /_(connected|enabled)$/i;

/** Every distinct setting as one line, except a FAMILY of keys that differ only after a `:` (one
 *  row per agent, say, `proactive_send_streak:<id>`): that is one line
 *  with its count and the query that reads it, so the page stays a page and nothing is hidden. */
function settings(rows: Row[]): string[] {
  const family = new Map<string, number>();
  for (const r of rows) { const p = /^([^:]+):./.exec(String(r.key))?.[1]; if (p) family.set(p, (family.get(p) ?? 0) + 1); }
  const shown = new Set<string>();
  return rows.flatMap((r) => {
    const p = /^([^:]+):./.exec(String(r.key))?.[1];
    if (!p || (family.get(p) ?? 0) < 2) return [`- ${r.key}: ${r.value}`];
    if (shown.has(p)) return [];
    shown.add(p);
    return [`- ${p}:* — ${family.get(p)} rows; read them with sql: select key, value from config where key like '${p}:%'`];
  });
}

function score(min: unknown, max: unknown): string {
  if (min !== null && max !== null) return `score ${min}–${max}`;
  if (min !== null) return `score from ${min}`;
  return max !== null ? `score up to ${max}` : 'any score';
}

/** The whole page. */
export function state(db: Database.Database = getReadOnlyDb()): string {
  const names = agentNames(db);
  const modelName = new Map(rows(db, 'SELECT id, name FROM models').map((m) => [m.id as string, m.name as string]));
  const ref = sourceRef();
  const grants = new Map<string, string>();
  for (const g of rows(db, 'SELECT agent_id, mode, count(*) AS n FROM grant_rule GROUP BY agent_id, mode ORDER BY mode')) {
    const prior = grants.get(g.agent_id as string);
    grants.set(g.agent_id as string, `${prior ? `${prior}, ` : ''}${g.n} ${g.mode}`);
  }
  const config = rows(db, 'SELECT key, value FROM config ORDER BY key');
  const section: Record<(typeof STATE_SECTIONS)[number], string> = {
    Version: `v${ref.version}, commit ${ref.sha}\n${pointerLine(ref)}`,
    Agents: or(rows(db, `SELECT a.id, a.name, a.status, a.classification, a.model_id, a.agent_type, g.name AS grp
        FROM agents a LEFT JOIN agent_groups g ON g.id = a.group_id ORDER BY a.status = 'terminated', a.name`).map((a) =>
      `- ${agentLabel(names, a.id as string)} · ${a.status} · ${a.classification}${a.agent_type ? ` · ${a.agent_type}` : ''}`
      + ` · model ${a.model_id ? modelName.get(a.model_id as string) ?? a.model_id : 'none'}${a.grp ? ` · group ${a.grp}` : ''}`
      + ` · grants ${grants.get(a.id as string) ?? 'none'}`), 'No agents.'),
    'Providers and models': or(rows(db, 'SELECT id, name, type, base_url, auth_type, is_validated FROM providers ORDER BY name').map((p) => {
      const models = rows(db, 'SELECT name, api_model_id, is_enabled, context_window, thinking_enabled FROM models WHERE provider_id = ? ORDER BY name', p.id)
        .map((m) => `  · ${m.name} (${m.api_model_id}) · ${m.is_enabled ? 'enabled' : 'disabled'}${m.context_window ? ` · window ${Number(m.context_window).toLocaleString('en-US')}` : ''}${m.thinking_enabled ? ' · thinking' : ''}`);
      return [`- ${p.name} (${p.type}) · ${p.is_validated ? 'validated' : 'not validated'}${p.base_url ? ` · base ${p.base_url}` : ''} · auth ${p.auth_type} · provider ${p.id}`, ...models].join('\n');
    }), 'No providers.'),
    'Router tiers': or(rows(db, 'SELECT id, display_name, score_min, score_max FROM router_tiers ORDER BY score_min IS NULL, score_min').map((t) => {
      const ms = rows(db, 'SELECT model_id FROM router_tier_models WHERE tier_id = ? ORDER BY priority', t.id).map((m) => modelName.get(m.model_id as string) ?? m.model_id);
      return `- ${t.display_name} (${t.id}) · ${score(t.score_min, t.score_max)} · ${ms.length ? ms.join(', ') : 'no models'}`;
    }), 'No router tiers.'),
    'Models for platform jobs': or(config.filter((c) => MODEL_KEY.test(c.key as string)).map((c) => `- ${c.key}: ${modelName.get(c.value as string) ?? c.value}`), 'None set.'),
    Schedules: or(rows(db, `SELECT id, title, next_run_at, schedule_status FROM work
        WHERE next_run_at IS NOT NULL AND state NOT IN ('done', 'failed', 'abandoned') ORDER BY next_run_at`).map((w) => {
      const next = toMs(w.next_run_at as number);
      return `- ${w.title ?? '(untitled)'} (task ${short(w.id as string)}) · next ${next === null ? 'unknown' : utc(next)}${w.schedule_status ? ` · ${w.schedule_status}` : ''}`;
    }), 'Nothing scheduled.'),
    Budgets: or(rows(db, 'SELECT id, scope, limit_usd, period FROM budgets ORDER BY id').map((b) => `- ${b.id} · ${b.scope} · $${b.limit_usd} ${b.period}`), 'No budgets.'),
    'Integrations and switches': or(config.filter((c) => SWITCH_KEY.test(c.key as string)).map((c) => `- ${c.key}: ${c.value}`), 'No integration switches set.'),
    Settings: or(settings(config.filter((c) => !MODEL_KEY.test(c.key as string) && !SWITCH_KEY.test(c.key as string))), 'No other settings.'),
    Ollama: redactText(JSON.stringify(getOllamaLock().getStatus())),
    'Healer diagnostics': (() => {
      const [d] = rows(db, 'SELECT report, created_at, critical_count, warning_count FROM healer_diagnostics ORDER BY created_at DESC LIMIT 1');
      if (!d) return 'No diagnostic has run.';
      const titles = String(d.report).split('\n').filter((l) => /^\s*\d+\.\s/.test(l)).map((l) => `- ${l.trim()}`);
      return `The latest, ${d.created_at} UTC: ${d.critical_count ?? 0} critical, ${d.warning_count ?? 0} warning.\n${or(titles, '(no findings listed)')}`;
    })(),
  };
  return STATE_SECTIONS.map((s) => `## ${s}\n${section[s]}`).join('\n\n');
}
