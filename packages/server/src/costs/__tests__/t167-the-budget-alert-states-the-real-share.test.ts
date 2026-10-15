// ════════════════════════════════════════════════════════════════════════════════════════
// t167 — THE BUDGET ALERT STATES THE REAL FIGURE, AND SAYS WHEN THE LIMIT IS REACHED.
//
// The witness (a user's box, the S5 walk): the owner's daily limit was set to $16.54 while
// $33.08 had already been spent in the last 24 hours, which is 200% of it. The alert texted
// "90% of your daily budget is used ($33.08 of $16.54 ...)": the highest threshold the check
// crosses (it stops at 90%) was printed as if it were the share, and nothing ever said the
// limit was REACHED, what that means for the agents, or how to lift it.
//
// The words now come from `currentSpend / limit`, not from the threshold's label. Below the
// limit they name the true share; at or over it they say plainly that the limit is reached, by
// how much, and what happens now. The latches, the once-per-window rule and the one-card-per-
// crossing rule are unchanged (the t138 file keeps proving those).
//
// Every clause drives the REAL doors, exactly as the t138 file does: the cost recorder, the
// budget setters the Ledger page calls, the real `sendAlert` and the real iMessage door. Only
// the operating-system transport underneath is replaced, so nothing is really texted.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-t167-budget');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t167-budget');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
    isTestRun: (): boolean => true,
  };
});

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t167-budget', 'dojo.db'),
  };
});

const { broadcasts, transport, transportFails } = vi.hoisted(() => ({
  broadcasts: [] as Array<{ type: string; data?: Record<string, unknown> }>,
  /** The operating-system transport under the iMessage door. Every call is a text that would
   *  have left the box; its arguments carry the text. */
  transport: [] as string[],
  transportFails: { on: false },
}));
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (e: { type: string; data?: Record<string, unknown> }) => { broadcasts.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  const record = (...a: unknown[]): string => {
    const line = JSON.stringify(a);
    transport.push(line);
    if (transportFails.on && !line.includes('--help')) throw new Error('transport down');
    return '';
  };
  return { ...orig, default: { ...orig, execSync: record, execFileSync: record }, execSync: record, execFileSync: record };
});

import { runMigrations } from '../../db/migrations.js';

// Each clause boots the real module graph (the iMessage door pulls in the engine) and runs the
// full migration chain; that is an import cost, not a timing assertion, and on a box shared by
// many suites it can pass the 30 s default. Nothing here measures time.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
import type { LogEntry } from '../../logger.js';

const OWNER = 'owner@example.test';
const db = (): Database.Database => mockDb.current!;

const logs: LogEntry[] = [];

beforeEach(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, '.dojo', 'logs'), { recursive: true });
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  broadcasts.length = 0;
  transport.length = 0;
  transportFails.on = false;
  logs.length = 0;
  seed();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  vi.resetModules();
});

function seed(withPhone = true): void {
  const d = db();
  d.prepare(`INSERT INTO providers (id, name, type, auth_type, is_validated, created_at, updated_at)
             VALUES ('prov', 'Prov', 'openai', 'api_key', 1, datetime('now'), datetime('now'))`).run();
  // $1 per million input tokens, $0 output: a call of N million input tokens costs exactly $N.
  d.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window,
                                 max_output_tokens, input_cost_per_m, output_cost_per_m, is_enabled,
                                 created_at, updated_at)
             VALUES ('mdl', 'prov', 'Mdl', 'mdl-1', '["text","tools"]', 65536, 8192, 1.0, 0, 1,
                     datetime('now'), datetime('now'))`).run();
  d.prepare(`INSERT INTO agents (id, name, model_id, status, created_at, updated_at)
             VALUES ('ag', 'Helper', 'mdl', 'idle', datetime('now'), datetime('now'))`).run();
  if (withPhone) setPhone(OWNER);
}

function setPhone(address: string | null): void {
  db().prepare("DELETE FROM config WHERE key = 'imessage_approved_senders'").run();
  if (address === null) return;
  db().prepare(`INSERT INTO config (key, value) VALUES ('imessage_approved_senders', ?)`)
    .run(JSON.stringify([{ address, name: 'Owner', is_primary: true }]));
}

/** The modules as a freshly booted process sees them. A "restart" is a new call. */
async function boot(): Promise<{
  recordCost: typeof import('../tracker.js').recordCost;
  budget: typeof import('../budget.js');
  bridge: typeof import('../../services/imessage-bridge.js');
}> {
  vi.resetModules();
  // A fresh process has a fresh logger: hook the dashboard's log feed onto THIS one.
  (await import('../../logger.js')).setLogBroadcast((e) => { logs.push(e); });
  const tracker = await import('../tracker.js');
  const budget = await import('../budget.js');
  const bridge = await import('../../services/imessage-bridge.js');
  return { recordCost: tracker.recordCost, budget, bridge };
}

/** One model call costing `dollars`, through the real cost door. */
function spend(recordCost: typeof import('../tracker.js').recordCost, dollars: number, agentId = 'ag'): void {
  recordCost({
    agentId, modelId: 'mdl', providerId: 'prov',
    inputTokens: Math.round(dollars * 1_000_000), outputTokens: 0,
  });
}

/** What reached the owner's phone: the platform's own outbound rows at the iMessage door. */
function ownerTexts(): Array<{ recipient_id: string; outcome: string; channel: string }> {
  return db().prepare(
    "SELECT recipient_id, outcome, channel FROM deliveries WHERE agent_id = 'platform' AND tool = 'alert' ORDER BY rowid",
  ).all() as Array<{ recipient_id: string; outcome: string; channel: string }>;
}
const sentTexts = (): string[] => transport.filter((t) => !t.includes('--help') && !t.includes('which'));
/** The budget's dashboard notification: the owner card the door makes beside each text (t138
 *  round 2; before it, a `cost:alert` frame). Each entry is the percentage the card names. */
const budgetCards = (): Array<{ percentage: number }> =>
  (broadcasts as Array<Record<string, unknown>>)
    .filter((b) => b.type === 'chat:error' && b.agentId === 'platform')
    .map((b) => ({ percentage: Number(/(\d+)%/.exec(String(b.error))?.[1]) }));

/** The words of every budget card the dashboard would show. */
const budgetCardWords = (): string[] =>
  (broadcasts as Array<Record<string, unknown>>)
    .filter((b) => b.type === 'chat:error' && b.agentId === 'platform')
    .map((b) => String(b.error));

describe('t167 (i): a limit set UNDER what is already spent says the limit is reached, with the true figures', () => {
  it('the measured shape: $33.08 spent, the limit set to $16.54 -> one text, "reached", $16.54 over, never "90%"', async () => {
    const { recordCost, budget } = await boot();
    budget.setGlobalBudget(1000);                // a roomy limit: nothing to cross
    spend(recordCost, 33.08);
    expect(ownerTexts()).toHaveLength(0);
    budget.setGlobalBudget(16.54);               // the owner moves the line under the spend
    budget.checkBudget('ag', 0.01);              // the next call's own pre-check sees it

    expect(ownerTexts(), 'one owner outbound').toHaveLength(1);
    const [text] = sentTexts();
    expect(text).toContain('$33.08');
    expect(text).toContain('$16.54');
    expect(text).toMatch(/limit.*reached/i);
    expect(text, 'the over-by figure is the true difference').toContain('$16.54 over');
    expect(text, 'the share is not the threshold label').not.toMatch(/\b90%/);
    expect(text, 'what happens now: a free model, then waiting').toMatch(/free model/i);
    expect(text).toMatch(/waits? until/i);
    expect(text, 'messages are kept').toMatch(/messages? (?:is|are) kept/i);
    expect(text).toContain('last 24 hours');

    // The card is the same words, once; another check in the window adds nothing.
    expect(budgetCardWords(), 'one card, the very words that were texted').toHaveLength(1);
    expect(text).toContain(budgetCardWords()[0]);
    budget.checkBudget('ag', 0.01);
    spend(recordCost, 1);
    expect(ownerTexts(), 'once per window').toHaveLength(1);
  });

  it('an agent budget set under that agent\'s spend says the same, for that agent and its period (no free-model claim: the agent budget has none)', async () => {
    const { recordCost, budget } = await boot();
    budget.setGlobalBudget(1000);
    spend(recordCost, 6);
    budget.setAgentBudget('ag', 4, 'weekly');
    budget.checkBudget('ag', 0.01);
    expect(ownerTexts()).toHaveLength(1);
    const [text] = sentTexts();
    expect(text).toContain('Helper');
    expect(text).toContain('$6.00');
    expect(text).toContain('$4.00');
    expect(text).toMatch(/limit.*reached/i);
    expect(text).toContain('$2.00 over');
    expect(text).toMatch(/weekly/);
    expect(text).not.toMatch(/\b90%/);
    expect(text, 'an agent budget has no free-model switch').not.toMatch(/free model/i);
  });
});

describe('t167 (ii): a gradual crossing still gets today\'s warning, with the TRUE share', () => {
  it('92% of the day: "92% of your daily budget is used ($9.20 of $10.00 in the last 24 hours)"', async () => {
    const { recordCost, budget } = await boot();
    budget.setGlobalBudget(10);
    spend(recordCost, 9.2);
    expect(ownerTexts()).toHaveLength(1);
    expect(sentTexts()[0]).toContain('Budget alert: 92% of your daily budget is used ($9.20 of $10.00 in the last 24 hours).');
    expect(sentTexts()[0]).not.toMatch(/reached/i);
  });

  it('one call that jumps to 95% is ONE text naming 95%, and a 51% crossing names 51% (the line it crossed is 50)', async () => {
    const a = await boot();
    a.budget.setGlobalBudget(10);
    spend(a.recordCost, 9.5);
    expect(ownerTexts()).toHaveLength(1);
    expect(sentTexts()[0]).toContain('95%');
    expect(sentTexts()[0]).not.toContain('90%');

    const b = await boot();
    db().prepare('DELETE FROM cost_records').run();
    b.budget.setGlobalBudget(20);                // a new line: re-armed
    spend(b.recordCost, 10.2);
    expect(ownerTexts()).toHaveLength(2);
    expect(sentTexts()[1]).toContain('51%');
    expect(sentTexts()[1]).not.toContain('50%');
  });

  it('99.6% is still a warning, not "reached": the limit is reached only when the spend is at it', async () => {
    const { recordCost, budget } = await boot();
    budget.setGlobalBudget(10);
    spend(recordCost, 9.96);
    expect(ownerTexts()).toHaveLength(1);
    expect(sentTexts()[0]).toContain('99%');
    expect(sentTexts()[0]).not.toMatch(/reached/i);
  });
});
