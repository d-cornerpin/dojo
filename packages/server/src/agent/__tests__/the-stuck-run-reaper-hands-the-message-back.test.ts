// ════════════════════════════════════════════════════════════════════════════════════════
// THE STUCK-RUN REAPER HANDS THE OWNER'S MESSAGE BACK WHILE THE SERVER STAYS UP.
//
// The periodic reaper (`runtime.ts recoverStuckAgents`) judges a run dead — a `working` row
// stale past the threshold that no live run owns — and closes its turn `terminated`. Before
// this, the ask that turn had claimed stayed `claimed` until some later boot, and a boot's
// reconcile then usually skipped it as too old: the owner's message was never answered.
// Now the same reconcile the boot runs (`work/orphaned-claims.ts`, one function, two callers)
// hands it back at once and the agent is woken to serve it. At boot the reaper leaves that to
// index.ts step 4b1, which runs after the staleness sweep.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
// The reaper's interval is armed when `runtime.js` is imported, so the clock is faked first.
vi.hoisted(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); });

vi.mock('../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-reaper-hand-back', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
// The turn machinery is irrelevant here — mocked so importing `runtime.js` never dials a model.
vi.mock('../v2/loop.js', () => ({ runV2Turn: vi.fn(async () => undefined) }));

import { runMigrations } from '../../db/migrations.js';
import { askIdForMessage, claimAsk, stampClaimingTurn } from '../../work/store.js';
import { insertMessage } from '../../memory/message-store.js';
import { handBackFactsFor } from '../../work/orphaned-claims.js';
import { FX, FXID } from '../../../../../deploy/checks/fixture-vocabulary.mjs';
import * as rt from '../runtime.js';

const AGENT = FXID.n4;
const db = (): Database.Database => mockDb.current!;

const askState = (): string =>
  (db().prepare('SELECT state FROM work WHERE id = ?').get(askIdForMessage('m-1')) as { state: string }).state;
const facts = (): string | null => handBackFactsFor(askIdForMessage('m-1'));

/** A run that claimed the owner's message and then wedged: `working`, its row long stale, its turn open. */
function wedgedRunHoldingTheOwnersMessage(): void {
  insertMessage({
    id: 'm-1', agentId: AGENT, role: 'user', content: 'can you check the roof quote?',
    lane: 'owner', channel: 'dashboard', senderId: 'owner', authorized: true, conversationId: 'conv-1',
    inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  } as never);
  claimAsk(askIdForMessage('m-1'), AGENT);
  stampClaimingTurn(askIdForMessage('m-1'), 7);
  db().prepare(
    `INSERT INTO turns (agent_id, turn_number, kind, root_kind, root_id, started_at, answered)
     VALUES (?, 7, 'user', 'ask', 'm-1', datetime('now', '-3 hours'), 0)`,
  ).run(AGENT);
  db().prepare("UPDATE agents SET status = 'working', updated_at = datetime('now', '-3 hours') WHERE id = ?").run(AGENT);
}

afterAll(() => { vi.useRealTimers(); });

beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.pragma('foreign_keys = ON');
  d.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, '${FX.n4}', 'idle', '1970-01-01')`).run(AGENT);
  d.prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES ('conv-1', ?, 'dashboard', 'owner')`).run(AGENT);
});

describe('the stuck-run reaper, while the server stays up', () => {
  it('hands the dead turn\'s owner message back through the one reconcile, and wakes the agent', async () => {
    wedgedRunHoldingTheOwnersMessage();
    const wake = vi.spyOn(rt.getAgentRuntime(), 'handleMessage').mockResolvedValue(undefined as never);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 10);
    expect(askState(), 'not claimed until some later boot').toBe('open');
    expect(facts()).toContain('roof quote');
    expect(wake).toHaveBeenCalledWith(AGENT, '');
    wake.mockRestore();
  });

  it('at boot it only reaps: index.ts 4b1 hands the message back, after the staleness sweep', () => {
    wedgedRunHoldingTheOwnersMessage();
    rt.runStartupRecoverySweep();
    expect(askState()).toBe('claimed');
    const t = db().prepare('SELECT exit_reason FROM turns WHERE agent_id = ? AND turn_number = 7').get(AGENT) as { exit_reason: string };
    expect(t.exit_reason).toBe('terminated');
  });
});
