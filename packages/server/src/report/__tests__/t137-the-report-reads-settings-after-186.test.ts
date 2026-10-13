// ════════════════════════════════════════════════════════════════════════════════════════
// t137 (v3.3.3) — `dojo_report` STILL COLLECTS ITS SETTINGS ON A BODY MIGRATION 186 HAS RUN ON.
//
// The settings collector (`collect.ts`'s `readSettings`) used to SELECT
// `providers.max_unattended_minutes` and the telemetry attachment emitted it as
// `settings.max_unattended_minutes`. Migration 186 drops that column (OR-LONG-JOBS: no total-time
// cap; orchestrator ruling R-V333-2 option (a)), so a collector still naming it would throw
// `no such column` on every report from an upgraded box.
//
// Driven through the REAL door — the `dojo_report` tool handler's `gather` then `draft`, on the real
// migration chain (186 included) — and read back from the stored attachment. The schema id stays
// `dojo-telemetry-1`: nothing in the tree enforces a version change on removing a field whose
// source no longer exists (re-derived at this head; see the t137 report).
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations.js';
import { reportHandlers } from '../../agent/tools/cat/report.js';
import { getReport } from '../store.js';
import type { ToolCall } from '@dojo/shared';

const AGENT = 'agent-t137-report-settings';

const call = async (args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> =>
  reportHandlers.dojo_report({
    agentId: AGENT, name: 'dojo_report', args, callId: 'c1', toolCall: {} as ToolCall,
  });

beforeEach(() => {
  runMigrations();
  const db = getDb();
  db.prepare('DELETE FROM dojo_reports').run();
  db.prepare(
    `INSERT OR IGNORE INTO providers (id, name, type, auth_type, first_chunk_timeout_ms, prefill_tokens_per_sec)
     VALUES ('p-t137', 'P', 'openai-compatible', 'none', 600000, 321)`,
  ).run();
  db.prepare("INSERT OR IGNORE INTO models (id, provider_id, name, api_model_id) VALUES ('m-t137', 'p-t137', 'M', 'm')").run();
  db.prepare("INSERT OR IGNORE INTO agents (id, name, model_id, status) VALUES (?, 'Reporter', 'm-t137', 'idle')").run(AGENT);
});

describe('the settings collector on a post-186 body', () => {
  it('the fixture IS post-186: the column is gone', () => {
    const cols = (getDb().prepare('PRAGMA table_info(providers)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).not.toContain('max_unattended_minutes');
  });

  it('gather and draft succeed, and the attachment carries the provider\'s real settings and no budget field', async () => {
    const gathered = await call({ phase: 'gather' });
    expect(gathered.isError, gathered.content).toBe(false);
    const id = /Report ([0-9a-f-]{36}) opened/.exec(gathered.content)?.[1];
    expect(id, `no report id in: ${gathered.content.slice(0, 200)}`).toBeTruthy();
    // The attachment is built mechanically at `draft`, from what `gather` collected.
    const drafted = await call({
      phase: 'draft', report_id: id, lane: 'permission',
      title: 'a provider setting read after an upgrade',
      what_happened: 'the report collected the settings of an upgraded box',
      what_should_have_happened: 'the same, with no error',
      why_it_went_wrong: 'nothing went wrong; this is a regression guard',
      fix_ideas: 'none needed',
    });
    expect(drafted.isError, drafted.content).toBe(false);

    const settings = (getReport(id!)?.telemetry as { settings?: Record<string, unknown> } | undefined)?.settings;
    // Positive control: the collector read THIS agent's provider row — the declared values come back.
    expect(settings).toMatchObject({
      provider_kind: 'openai-compatible', first_chunk_timeout_ms: 600000, prefill_tokens_per_sec: 321,
    });
    expect(settings).not.toHaveProperty('max_unattended_minutes');
  });
});
