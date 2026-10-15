// ════════════════════════════════════════════════════════════════════════════════════════
// t138 (#8) — A BUDGET WARNING REACHES THE OWNER, ONCE PER REAL CROSSING.
//
// The witness (tracker #8, owner-typed): "Warning thresholds for account budgets are being hit
// with no notification to the user. The notification needs to be engine generated and sent via
// imessage." At v3.3.2 every budget crossing called `sendAlert(…, 'warning')` and `sendAlert`
// drops everything but `critical`/`notice` before the phone, so no budget alert ever reached it;
// the 50% and 75% crossings did not even try.
//
// Owner ruling OR-V333-SET (3): the platform may message the owner directly for exactly two
// things, budget alerts and a broken/silent agent. So the fix lives at the CALL SITE (the budget
// class sends `notice`), never by loosening the filter for everything — the last clause below
// keeps the filter honest.
//
// Every clause drives the REAL doors: the cost recorder (`recordCost`, the one place a model
// call's price lands), the budget setters the Ledger page calls, the real `sendAlert`, the real
// iMessage door (`sendIMessage`, which writes the `deliveries` row). Only the operating-system
// transport underneath (`child_process`) is replaced, so nothing is really texted.
// ════════════════════════════════════════════════════════════════════════════════════════

// RED-FIRST at 00a2b34d: clauses marked `it.fails` are the witness, failing before the fix;
// the fix commits flip them to `it`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-t138-budget');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t138-budget');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t138-budget', 'dojo.db'),
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

describe('the RED witness (#8): a daily-budget crossing reaches the owner', () => {
  it('a cost record pushing daily spend over 90% texts the owner exactly once, as the platform', async () => {
    const { recordCost, budget } = await boot();
    budget.setGlobalBudget(10);
    spend(recordCost, 9.2);

    const rows = ownerTexts();
    expect(rows, 'one owner outbound under the platform sender').toHaveLength(1);
    expect(rows[0]).toMatchObject({ recipient_id: OWNER, outcome: 'delivered', channel: 'imessage' });
    const sent = sentTexts();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('92%');
    expect(logs.some((l) => /Alert suppressed/.test(l.message))).toBe(false);
  });

  it('50%, 75% and 90% are each told once as spend climbs through them', async () => {
    const { recordCost, budget } = await boot();
    budget.setGlobalBudget(10);
    spend(recordCost, 5.1);
    expect(ownerTexts()).toHaveLength(1);
    expect(sentTexts()[0]).toContain('51%');
    spend(recordCost, 0.2); // 53%: no new crossing
    expect(ownerTexts()).toHaveLength(1);
    spend(recordCost, 2.5); // 78%
    expect(ownerTexts()).toHaveLength(2);
    expect(sentTexts()[1]).toContain('78%');
    spend(recordCost, 1.5); // 93%
    expect(ownerTexts()).toHaveLength(3);
    expect(sentTexts()[2]).toContain('93%');
    spend(recordCost, 0.3); // still over: no repeat
    expect(ownerTexts()).toHaveLength(3);
  });

  it('one call that jumps past several thresholds at once is ONE text, naming the true share (95%, not the highest line passed)', async () => {
    const { recordCost, budget } = await boot();
    budget.setGlobalBudget(10);
    spend(recordCost, 9.5);
    expect(ownerTexts()).toHaveLength(1);
    expect(sentTexts()[0]).toContain('95%');
    expect(sentTexts()[0]).not.toContain('50%');
    // and all three are latched: nothing more for 50/75 on the next call
    spend(recordCost, 0.1);
    expect(ownerTexts()).toHaveLength(1);
    expect(budgetCards().map((a) => a.percentage)).toEqual([95]);
  });

  it('an agent budget crossing names the agent and its period', async () => {
    const { recordCost, budget } = await boot();
    budget.setGlobalBudget(1000);
    budget.setAgentBudget('ag', 4, 'daily');
    spend(recordCost, 3.7);
    expect(ownerTexts()).toHaveLength(1);
    expect(sentTexts()[0]).toContain('Helper');
    expect(sentTexts()[0]).toContain('92%');
    expect(sentTexts()[0]).toMatch(/daily/);
  });
});

describe('once per REAL crossing: restart-safe, re-arms only after a genuine drop', () => {
  it('a restart does not re-alert a crossing already told', async () => {
    let mods = await boot();
    mods.budget.setGlobalBudget(10);
    spend(mods.recordCost, 9.2);
    expect(ownerTexts()).toHaveLength(1);

    mods = await boot(); // a fresh process over the same database
    spend(mods.recordCost, 0.1);
    mods.budget.checkBudget('ag', 0.01);
    expect(ownerTexts()).toHaveLength(1);
  });

  it('a full drop INSIDE the window does not re-arm; once the window has turned over, a new crossing texts again', async () => {
    const { recordCost, budget } = await boot();
    budget.setGlobalBudget(10);
    spend(recordCost, 9.2);
    expect(ownerTexts()).toHaveLength(1);

    // All of today's spend leaves the rolling day, and spend climbs back over the line — but
    // the owner was told about this line less than a day ago (fix round 1, I1).
    db().prepare("UPDATE cost_records SET created_at = datetime('now', '-2 days')").run();
    spend(recordCost, 0.1);
    spend(recordCost, 9.0);
    expect(ownerTexts()).toHaveLength(1);

    // A day later (the told-at stamps age with everything else), the next crossing is new.
    db().prepare("UPDATE cost_records SET created_at = datetime('now', '-2 days')").run();
    db().prepare(`UPDATE budgets SET alert_50_sent = alert_50_sent - 2 * 86400 WHERE alert_50_sent > 0`).run();
    db().prepare(`UPDATE budgets SET alert_75_sent = alert_75_sent - 2 * 86400 WHERE alert_75_sent > 0`).run();
    db().prepare(`UPDATE budgets SET alert_90_sent = alert_90_sent - 2 * 86400 WHERE alert_90_sent > 0`).run();
    spend(recordCost, 9.1);
    expect(ownerTexts()).toHaveLength(2);
    expect(sentTexts()[1]).toContain('91%');
  });

  it('a weekly agent budget is measured over ONE window by both checks — no alert/re-arm flapping', async () => {
    const { recordCost, budget } = await boot();
    budget.setGlobalBudget(1000);
    budget.setAgentBudget('ag', 10, 'weekly');
    // Prior weeks: $20 spent long ago. This week: nothing yet.
    db().prepare(`INSERT INTO cost_records (id, agent_id, model_id, provider_id, input_tokens, output_tokens,
                                            cost_usd, created_at)
                  VALUES ('old-1', 'ag', 'mdl', 'prov', 0, 0, 20, datetime('now', '-30 days'))`).run();
    // Three turns: the pre-call budget check, then the call's cost lands. $1 each = 10%..30%.
    for (let i = 0; i < 3; i++) {
      expect(budget.checkBudget('ag', 0.01).allowed).toBe(true);
      spend(recordCost, 1);
    }
    expect(budgetCards(), 'no budget event at 30% of the week').toEqual([]);
    expect(ownerTexts()).toHaveLength(0);
  });

  it('a monthly agent budget is a rolling month, not all time', async () => {
    const { budget } = await boot();
    budget.setGlobalBudget(1000);
    budget.setAgentBudget('ag', 10, 'monthly');
    db().prepare(`INSERT INTO cost_records (id, agent_id, model_id, provider_id, input_tokens, output_tokens,
                                            cost_usd, created_at)
                  VALUES ('old-1', 'ag', 'mdl', 'prov', 0, 0, 50, datetime('now', '-90 days'))`).run();
    expect(budget.checkBudget('ag', 0.01).allowed, 'last quarter does not spend this month').toBe(true);
    expect(ownerTexts()).toHaveLength(0);
  });
});

describe('fix round 1 (I1): at most ONE text per threshold per budget window', () => {
  // The review's case: a $10 day spent in $0.25 calls, hovering at the 90% line. A record
  // ageing out of the rolling day drops spend $0.25 (2.5 points) and the next call brings it
  // back. With a 2-point re-arm band that is a fresh text every turn; the owner asked for
  // true blockers only.
  it('steady spend near the line: one text, however many times it dips and returns', async () => {
    const { recordCost, budget } = await boot();
    budget.setGlobalBudget(10);
    const seedRow = db().prepare(`INSERT INTO cost_records (id, agent_id, model_id, provider_id, input_tokens,
                                    output_tokens, cost_usd, created_at)
                                  VALUES (?, 'ag', 'mdl', 'prov', 0, 0, 0.25, datetime('now', ?))`);
    // 35 x $0.25 = $8.75 already spent today, oldest first.
    for (let i = 0; i < 35; i++) seedRow.run(`seed-${i}`, `-${23 * 60 - i} minutes`);
    spend(recordCost, 0.25); // $9.00: 90% (and 50/75) crossed in one check
    expect(ownerTexts()).toHaveLength(1);

    for (let turn = 0; turn < 8; turn++) {
      // The oldest record leaves the rolling day: $8.75, 87.5%.
      db().prepare(`UPDATE cost_records SET created_at = datetime('now', '-2 days')
                    WHERE id = (SELECT id FROM cost_records WHERE created_at >= datetime('now', '-1 day')
                                ORDER BY created_at ASC LIMIT 1)`).run();
      // Real turns are more than the daily-spend cache's 5 s apart; expire it as time would.
      (await import('../tracker.js')).invalidateDailySpendCache();
      expect(budget.checkBudget('ag', 0.01).allowed).toBe(true); // the next turn's pre-call check
      spend(recordCost, 0.25); // back to $9.00
    }
    expect(ownerTexts(), 'one text for the 90% line in this window').toHaveLength(1);
  });

  it('saving the SAME limit again is not a change: no re-arm, no second text', async () => {
    const { recordCost, budget } = await boot();
    budget.setGlobalBudget(10);
    spend(recordCost, 9.2);
    budget.setGlobalBudget(10);
    budget.checkBudget('ag', 0.01);
    spend(recordCost, 0.1);
    expect(ownerTexts()).toHaveLength(1);
  });
});

describe('backwards lifecycle', () => {
  it('limit raised above current spend after an alert: silent re-arm; lowered again: told once', async () => {
    const { recordCost, budget } = await boot();
    budget.setGlobalBudget(10);
    spend(recordCost, 9.2);
    expect(ownerTexts()).toHaveLength(1);

    budget.setGlobalBudget(100); // 9.2% of the new limit
    expect(budget.checkBudget('ag', 0.01).allowed).toBe(true);
    expect(ownerTexts()).toHaveLength(1);

    budget.setGlobalBudget(10); // the owner puts it back: spend is over 90% again — a real crossing
    expect(budget.checkBudget('ag', 0.01).allowed).toBe(true);
    expect(ownerTexts()).toHaveLength(2);
  });

  it('limit lowered under current spend: the next check tells the owner once', async () => {
    const { recordCost, budget } = await boot();
    budget.setGlobalBudget(100);
    spend(recordCost, 6);
    expect(ownerTexts()).toHaveLength(0);
    budget.setGlobalBudget(10);
    budget.checkBudget('ag', 0.01);
    budget.checkBudget('ag', 0.01);
    expect(ownerTexts()).toHaveLength(1);
    expect(sentTexts()[0]).toContain('60%');
  });
});

describe('no phone channel: the notice still lands on the dashboard', () => {
  it('no safe sender set up → no text, a dashboard event, and an owner-notice entry carrying the words', async () => {
    setPhone(null);
    const { recordCost, budget } = await boot();
    budget.setGlobalBudget(10);
    spend(recordCost, 9.2);

    expect(sentTexts()).toHaveLength(0);
    expect(ownerTexts()).toHaveLength(0);
    expect(budgetCards().map((a) => a.percentage)).toEqual([92]);
    const notice = logs.filter((l) => l.component === 'owner-notice');
    expect(notice, 'one dashboard-visible owner notice').toHaveLength(1);
    expect(notice[0].level).toBe('warn');
    expect(notice[0].message).toContain('92%');
  });

  it('the phone send fails → the same dashboard notice, so the owner is not left with nothing', async () => {
    const { recordCost, budget } = await boot();
    budget.setGlobalBudget(10);
    transportFails.on = true;
    spend(recordCost, 9.2);
    const rows = ownerTexts();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('failed');
    const notice = logs.filter((l) => l.component === 'owner-notice');
    expect(notice).toHaveLength(1);
    expect(notice[0].message).toContain('92%');
  });
});

describe('the filter is NOT loosened: a class that was never granted the phone still cannot reach it', () => {
  it("'warning' and 'info' stay off the phone", async () => {
    const { bridge } = await boot();
    bridge.sendAlert('an ungranted class of message', 'warning');
    bridge.sendAlert('another ungranted class of message', 'info');
    expect(sentTexts()).toHaveLength(0);
    expect(ownerTexts()).toHaveLength(0);
  });
});
