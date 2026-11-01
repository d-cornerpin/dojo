// ════════════════════════════════════════════════════════════════════════════════════════
// AN OUTSIDE SEND IS ON THE LEDGER BEFORE IT GOES.
//
// The door records a send AFTER its transport returns. A process killed between the two
// (iMessage handed the text over, the row not yet written) left no trace: on restart the ask
// read as unanswered and was answered again. Now a scope on an outside channel writes its
// INTENT first — the same `deliveries` row, `outcome='pending'`, carrying what is being sent —
// and the door turns that row into what it observed. A crash leaves `pending`: "may have been
// delivered", which the orphaned-claim hand-back tells the agent to check
// (`work/__tests__/a-restart-mid-reply-hands-the-owners-message-back.test.ts`).
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-outbound-intent', 'dojo.db'),
  };
});

import { runMigrations } from '../../../db/migrations.js';
import { withOutboundAsync, withOutbound, recordAtDoor, currentOutboundDeliveryId } from '../outbound.js';
import { openTurnContext, endTurnContext } from '../../turn-context.js';
import { askIdForMessage, claimAsk, stampClaimingTurn } from '../../../work/store.js';
import { insertMessage } from '../../../memory/message-store.js';
import { FX, FXID } from '../../../../../../deploy/checks/fixture-vocabulary.mjs';

const AGENT = FXID.n4;
const rows = (): Array<{ id: string; outcome: string; detail: string | null; turn_number: number | null; recipient_id: string | null }> =>
  mockDb.current!.prepare('SELECT id, outcome, detail, turn_number, recipient_id FROM deliveries ORDER BY rowid').all() as never;
const IM = { agentId: AGENT, tool: 'auto-route', channel: 'imessage' as const, recipientId: '+15550000', conversationId: 'conv-dash', text: 'The roof quote is fine.' };

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, '${FX.n4}', 'idle', '1970-01-01')`).run(AGENT);
  db.prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES ('conv-dash', ?, 'dashboard', 'owner')`).run(AGENT);
  endTurnContext(AGENT);
  const turn = openTurnContext(AGENT);
  turn.turnNumber = 7;
  turn.root = { kind: 'ask', id: 'm-ask', sourceMessageId: 'm-ask', conversationId: 'conv-dash' };
});

describe('the intent is written before an outside send', () => {
  it('while the transport runs the row reads pending with the text; the door makes it what it saw — one row', async () => {
    let during: ReturnType<typeof rows> = [];
    let idDuring: string | null = 'unset';
    await withOutboundAsync(IM, async () => {
      during = rows();
      idDuring = currentOutboundDeliveryId();
      recordAtDoor({ outcome: 'delivered', channel: 'imessage' });
    });
    expect(during).toHaveLength(1);
    expect(during[0]).toMatchObject({ outcome: 'pending', turn_number: 7, recipient_id: '+15550000' });
    expect(during[0].detail).toContain('The roof quote is fine.');
    expect(idDuring, 'no door has said anything yet, so there is no delivery to point at').toBeNull();
    const after = rows();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(during[0].id);
    expect(after[0].outcome).toBe('delivered');
    expect(after[0].detail ?? '', 'the intent text is not left on a settled row').not.toContain('The roof quote');
  });

  it('a send that reaches no transport leaves no row, exactly as before', async () => {
    await withOutboundAsync(IM, async () => null);
    expect(rows()).toHaveLength(0);
  });

  it('a send that throws before the door is a failed row', async () => {
    await expect(withOutboundAsync(IM, async () => { throw new Error('bridge down'); })).rejects.toThrow('bridge down');
    expect(rows().map((r) => r.outcome)).toEqual(['failed']);
  });

  it('a synchronous outside send gets the same intent', () => {
    let during: ReturnType<typeof rows> = [];
    withOutbound(IM, () => { during = rows(); recordAtDoor({ outcome: 'failed', channel: 'imessage', detail: 'exit 1' }); });
    expect(during.map((r) => r.outcome)).toEqual(['pending']);
    expect(rows().map((r) => r.outcome)).toEqual(['failed']);
  });

  it('dashboard and agent-to-agent scopes write no intent: they have no outside transport to die inside', async () => {
    for (const channel of ['dashboard', 'a2a'] as const) {
      let during = -1;
      await withOutboundAsync({ ...IM, channel }, async () => { during = rows().length; });
      expect(during, channel).toBe(0);
    }
  });

  it('the door turning the intent into `delivered` closes the ask it answers, in the same unit', async () => {
    insertMessage({
      id: 'm-ask', agentId: AGENT, role: 'user', content: 'can you check the roof quote?', lane: 'owner',
      channel: 'dashboard', senderId: 'owner', authorized: true, conversationId: 'conv-dash',
      inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
    } as never);
    claimAsk(askIdForMessage('m-ask'), AGENT);
    stampClaimingTurn(askIdForMessage('m-ask'), 7);
    await withOutboundAsync(IM, async () => { recordAtDoor({ outcome: 'delivered', channel: 'imessage' }); });
    const w = mockDb.current!.prepare('SELECT state, result_delivery_id FROM work WHERE id = ?').get(askIdForMessage('m-ask')) as { state: string; result_delivery_id: string };
    expect(w.state).toBe('done');
    expect(w.result_delivery_id).toBe(rows()[0].id);
  });
});
