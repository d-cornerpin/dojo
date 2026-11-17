// A reply went but its request was never settled (the settle after the verdict failed): the start-up heal settles
// it. A request an older version stranded, which the update parks rather than serves, is left alone.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => (await import('./helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../steps/finalize/link-backstop.js', () => ({ appendUndeliveredLinks: async (s: unknown) => s }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { healStuckClaims } from '../../../work/ask-remediation.js';
import { freshReplyDb, testDb, AGENT } from './helpers/reply-sender.js';
import { claimedAsk } from './helpers/owner-stop.js';
import { CONV, askRow, turnRow } from './helpers/text-request.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date());
  freshReplyDb(runMigrations);
});

describe('a request left claimed after its reply is settled at the next boot', () => {
  it('a delivered reply with no settlement closes its request at the heal', () => {
    const ask = claimedAsk('msg-1', CONV, 1);
    turnRow(1);
    testDb().prepare(
      `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, outcome, created_at, updated_at)
       VALUES ('d-1', ?, 1, 'auto-route', 'imessage', ?, 'delivered', datetime('now', '+1 second'), datetime('now'))`,
    ).run(AGENT, CONV);

    healStuckClaims();
    expect(askRow(ask)).toEqual({ state: 'done', result_delivery_id: 'd-1' });
  });

  it('a claim stranded more than a week ago is left alone, never re-opened to be answered late', () => {
    const ask = claimedAsk('msg-old', CONV, 3);
    turnRow(3);
    testDb().prepare('UPDATE work SET opened_at = ? WHERE id = ?').run(Date.now() - 8 * 24 * 3_600_000, ask);

    healStuckClaims();
    expect(askRow(ask).state).toBe('claimed');
  });

  it('settles under its own name', () => {
    const ask = claimedAsk('msg-4', CONV, 4);
    turnRow(4);
    healStuckClaims();
    const actor = testDb().prepare("SELECT actor FROM work_events WHERE work_id = ? AND kind = 'transition' ORDER BY id DESC LIMIT 1").get(ask) as { actor: string };
    expect(actor.actor).toBe('boot-heal');
  });

  it('an inherited request whose run died before this version stays claimed for the update to park', () => {
    const ask = claimedAsk('msg-2', CONV, 2);
    testDb().prepare(
      `INSERT INTO turns (agent_id, turn_number, kind, started_at, ended_at, exit_reason, answered)
       VALUES (?, 2, 'user', datetime('now', '-9 days'), datetime('now', '-9 days'), 'terminated', 0)`,
    ).run(AGENT);

    healStuckClaims();
    expect(askRow(ask).state).toBe('claimed');
  });
});
