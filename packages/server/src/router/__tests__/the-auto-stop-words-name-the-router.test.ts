// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 N42 fix round 1 — WHEN AN AUTO AGENT CANNOT RUN AT THE ROUTER WINDOW, THE OWNER IS TOLD
// WHAT TO CHANGE ON THE ROUTER, NOT "PICK A BIGGER MODEL".
//
// An auto-routed agent has no model of its own: what is too small is the one router window, set by
// the router's smallest model (or lowered with the Router tab's slider). "Point it at a bigger model"
// sends the owner to pin the agent to a big fixed model, which quietly moves every turn onto a pricier
// one. The owner-facing words — the WINDOW_TOO_SMALL card, the no-fit notice's card and the no-fit
// text — name the router's smallest model and the slider for an auto agent. A pinned agent keeps its
// words (control).
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
  closeDb: vi.fn(),
}));
const cards = vi.hoisted(() => [] as Array<{ code?: string; error?: string }>);
vi.mock('../../gateway/ws.js', () => ({ broadcast: (e: { code?: string; error?: string }) => { cards.push(e); }, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { reportStarvedWindow, __resetStarvedWindowsForTests } from '../../memory/window-starvation-card.js';
import { contextWindowPolicy } from '../../memory/budget.js';
import { wordsOf } from '../../healer/owner-notices.js';
import { noFitOwnerWords } from '../router-window-words.js';

const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  cards.length = 0;
  __resetStarvedWindowsForTests();
  db().prepare(`INSERT INTO providers (id, name, type, auth_type, is_validated, created_at, updated_at)
    VALUES ('prov', 'P', 'anthropic', 'agent-sdk', 1, datetime('now'), datetime('now'))`).run();
  const model = db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES (?, 'prov', ?, ?, '["text","tools"]', ?, 4096, 1, datetime('now'), datetime('now'))`);
  model.run('m-small', 'Dock Small', 'small', 8_192);
  model.run('m-big', 'Dock Big', 'big', 200_000);
  const tier = db().prepare('INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES (?, ?, 0)');
  tier.run('light', 'm-small');
  tier.run('standard', 'm-big');
  tier.run('heavy', 'm-big');
  const agent = db().prepare(`INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at) VALUES (?, ?, ?, 'idle', '{}', datetime('now'), datetime('now'))`);
  agent.run('a-auto', 'Dock Desk', 'auto');
  agent.run('a-pinned', 'Ledger', 'm-small');
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

const policy = contextWindowPolicy(8_192, { toolPayloadTokens: 2_000, maxOutputTokens: 4_096 });
const cardFor = (agentId: string): string => {
  reportStarvedWindow(agentId, 6_000, policy);
  return cards.filter((c) => c.code === 'WINDOW_TOO_SMALL').pop()?.error ?? '';
};

describe('an auto agent the router window cannot hold', () => {
  it('the WINDOW_TOO_SMALL card names the router\'s smallest model and the Router tab, never "a bigger model"', () => {
    const card = cardFor('a-auto');
    expect(card).toMatch(/Dock Small/);
    expect(card).toMatch(/Router tab/);
    expect(card).not.toMatch(/point it at a model with a bigger context window/i);
  });

  it('a slider set below the smallest model: the card says to raise the slider', () => {
    db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('router.context_window', '6000')").run();
    expect(cardFor('a-auto')).toMatch(/Context window for automatic choice/);
  });

  it('the no-fit notice the owner reads names the smallest model and the slider', () => {
    const words = noFitOwnerWords('a-auto');
    expect(words).toMatch(/Dock Small/);
    expect(words).toMatch(/Context window for automatic choice/);
    expect(words).not.toMatch(/Pick a bigger model for this agent/);
  });

  it('the no-fit text and its lasting card point at the Router tab, never the agent\'s detail page', () => {
    const text = wordsOf('nofit:a-auto');
    expect(text).toMatch(/Dock Desk/);
    expect(text).toMatch(/Router tab/);
    expect(text).not.toMatch(/detail page/);
  });
});

describe('CONTROL: a pinned agent keeps its words', () => {
  it('the card, the notice and the text still say to pick a bigger model or fewer tools', () => {
    expect(cardFor('a-pinned')).toMatch(/point it at a model with a bigger context window/);
    expect(noFitOwnerWords('a-pinned')).toMatch(/Pick a bigger model for this agent/);
    expect(wordsOf('nofit:a-pinned')).toMatch(/detail page/);
  });
});
