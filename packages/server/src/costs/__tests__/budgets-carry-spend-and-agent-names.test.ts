// ════════════════════════════════════════════════════════════════════════════════════════
// THE BUDGET ROUTE CARRIES SPEND AND AGENT NAMES.
//
// The dashboard's `getBudgets` (packages/dashboard/src/lib/api.ts) promises `global.spentUsd`
// and, per agent, `agentName` and `spentUsd`. The route `GET /api/costs/budget` sends
// `getBudgets()` unchanged, and `getBudgets` returned only the budget rows — so `spentUsd`
// arrived as `undefined`, the per-agent row called `spentUsd.toFixed(2)` on it and crashed the
// page, and the global tile showed the wrong "spent". These clauses pin the missing fields:
// the global spend is `getDailySpend()`, each agent's spend is `agentPeriodSpend(agentId,
// period)`, and each agent's name is the `agents.name` of its id (the id itself when no row).
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-budgets-spend');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-budgets-spend');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-budgets-spend', 'dojo.db'),
  };
});

const { broadcasts, transport, transportFails } = vi.hoisted(() => ({
  broadcasts: [] as Array<{ type: string; data?: Record<string, unknown> }>,
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
vi.mock('../../services/imessage-run.js', async (importOriginal) => {
  const cp = await import('node:child_process');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    runMessagesProgram: async (program: string, argv: readonly string[], opts: object) => String(cp.execFileSync(program, [...argv], opts)),
    wasCutByTheStop: () => false,
  };
});

import { runMigrations } from '../../db/migrations.js';
import { recordCost } from '../tracker.js';
import * as budget from '../budget.js';
import * as spendModule from '../spend.js';
import { setLogBroadcast } from '../../logger.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
import type { LogEntry } from '../../logger.js';

const db = (): Database.Database => mockDb.current!;

const logs: LogEntry[] = [];
setLogBroadcast((e) => { logs.push(e); });

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
});

function seed(): void {
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
             VALUES ('a1', 'Helper', 'mdl', 'idle', datetime('now'), datetime('now'))`).run();
}

/** The modules under test, imported once above; each case's fresh state is the DB in `beforeEach`. */
async function boot() {
  return { recordCost, budget, spend: spendModule };
}

/** One model call costing `dollars`, through the real cost door. */
function spend(recordCost: typeof import('../tracker.js').recordCost, dollars: number, agentId = 'a1'): void {
  recordCost({
    agentId, modelId: 'mdl', providerId: 'prov',
    inputTokens: Math.round(dollars * 1_000_000), outputTokens: 0,
  });
}

describe('budgets carry spend and agent names', () => {
  it('the global budget carries `spentUsd`: only what was spent inside the last 24 hours', async () => {
    const { recordCost, budget, spend: spendModule } = await boot();
    budget.setGlobalBudget(10);
    spend(recordCost, 3.5);                       // inside the last 24 hours
    db().prepare(`INSERT INTO cost_records (id, agent_id, model_id, provider_id, input_tokens, output_tokens, cost_usd, created_at)
                  VALUES ('cr-old', 'a1', 'mdl', 'prov', 7000000, 0, 7.0, datetime('now', '-2 days'))`).run();
    spendModule.invalidateDailySpendCache();
    expect(budget.getBudgets().global?.spentUsd).toBe(3.5);
  });

  it('an agent budget carries its own `spentUsd` and the agent\'s `name`', async () => {
    const { recordCost, budget, spend: spendModule } = await boot();
    budget.setAgentBudget('a1', 5, 'daily');
    spend(recordCost, 1.25, 'a1');                // a1's own spend today
    spend(recordCost, 9, 'a2');                   // someone else's spend today
    spendModule.invalidateDailySpendCache();
    const a1 = budget.getBudgets().agents.find((a) => a.agentId === 'a1');
    expect(a1?.spentUsd).toBe(1.25);
    expect(a1?.agentName).toBe('Helper');
  });

  it('an agent budget for an id with no agents row still carries the id as its name and zero spend', async () => {
    const { budget, spend: spendModule } = await boot();
    budget.setAgentBudget('ghost', 5, 'daily');   // no agents row exists for 'ghost'
    spendModule.invalidateDailySpendCache();
    const ghost = budget.getBudgets().agents.find((a) => a.agentId === 'ghost');
    expect(ghost?.agentName).toBe('ghost');
    expect(ghost?.spentUsd).toBe(0);
  });

  it('no global budget set: `global` stays null', async () => {
    const { budget } = await boot();
    // The migrations seed a default $25 global line (004_phase4.sql); "no global budget" means
    // that row is gone, so remove it before reading.
    db().prepare(`DELETE FROM budgets WHERE id = 'global_daily'`).run();
    expect(budget.getBudgets().global).toBeNull();
  });
});
