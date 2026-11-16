// A reply that still cannot get through after all its tries is told to the owner on one dashboard card per agent:
// each new failure raises its count on the same card. No text goes to the owner about it. A start line that fails
// is not an answer: no card, no notice.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const seen = vi.hoisted(() => ({ frames: [] as Array<Record<string, unknown>>, alerts: [] as unknown[] }));
vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => ({
  ...(await import('./helpers/reply-sender.js')).bridgeMock(await orig()),
  sendAlert: async (...args: unknown[]) => { seen.alerts.push(args); return true; },
}));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../steps/finalize/link-backstop.js', () => ({ appendUndeliveredLinks: async (s: unknown) => s }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: (f: Record<string, unknown>) => { seen.frames.push(f); } }));

import { runMigrations } from '../../../db/migrations.js';
import { routeTerminalReply } from '../steps/finalize/route-reply.js';
import { deliverDueReplies } from '../channel-sender.js';
import { servedOwnerNotices } from '../../../healer/owner-notice-kinds.js';
import { freshReplyDb, imessage, personTurn, testDb, AGENT, OWNER, PERSON, T0 } from './helpers/reply-sender.js';

const MIN = 60_000;
const KEY = `undelivered:${AGENT}`;
let now = T0;
let turn = 0;

/** One reply written and every one of its five tries failed. */
async function aReplyThatNeverGoes(text: string, tool?: string): Promise<void> {
  await routeTerminalReply(...personTurn(text, { channel: 'imessage' }, ++turn));
  if (tool) testDb().prepare("UPDATE deliveries SET tool = ? WHERE outcome = 'pending' AND payload_json IS NOT NULL").run(tool);
  for (const wait of [30_000, 2 * MIN, 10 * MIN, 30 * MIN, MIN]) {
    await deliverDueReplies(now);
    now += wait;
  }
}

const cards = () => seen.frames.filter((f) => f.type === 'chat:error' && f.cardKey === KEY && f.severity !== 'info');
const notices = () => testDb().prepare("SELECT content FROM messages WHERE content LIKE '[SOURCE: AGENT NOTICE%'").all();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  freshReplyDb(runMigrations);
  imessage.send.mockResolvedValue(false);
  seen.frames = [];
  seen.alerts = [];
  now = T0;
  turn = 0;
});

describe('many undelivered replies make one card whose count rises', () => {
  it('one failure: one informational card naming the person, the channel and that it is in the chat', async () => {
    await aReplyThatNeverGoes('the table is booked for eight');
    expect(cards()).toHaveLength(1);
    expect(cards()[0]).toMatchObject({ cardClass: 'informational' });
    expect(cards()[0].error).toMatch(new RegExp(`^1 reply could not be delivered since .+ UTC\\. Latest: iMessage to \\${PERSON} \\(.+\\)\\. It is in the chat\\.$`));
  });

  it('five failures in an evening: the same card, its count rising, and no text to the owner', async () => {
    for (let i = 1; i <= 5; i++) await aReplyThatNeverGoes(`answer ${i}`);
    expect(cards().map((c) => String(c.error).split(' could')[0])).toEqual(['1 reply', '2 replies', '3 replies', '4 replies', '5 replies']);
    expect(testDb().prepare("SELECT COUNT(*) AS n FROM healer_state WHERE scope = 'owner_told' AND key LIKE 'undelivered:%'").get()).toEqual({ n: 1 });
    expect(seen.alerts).toEqual([]);
    expect(imessage.send.mock.calls.filter(([to]) => to === OWNER)).toEqual([]);
  });

  it('once he has seen the card, the next day one new failure is a card of its own; nothing new, no card', async () => {
    for (let i = 1; i <= 5; i++) await aReplyThatNeverGoes(`answer ${i}`);
    expect(servedOwnerNotices().filter((c) => c.cardKey === KEY)).toHaveLength(1);
    expect(servedOwnerNotices().filter((c) => c.cardKey === KEY)).toEqual([]);
    // The evening is now yesterday.
    testDb().prepare("UPDATE deliveries SET updated_at = datetime('now', '-1 day')").run();
    testDb().prepare("UPDATE healer_state SET at_ms = at_ms - 86400000 WHERE key = ?").run(KEY);
    seen.frames = [];
    await aReplyThatNeverGoes('the next day');
    expect(cards()).toHaveLength(1);
    expect(cards()[0].error).toMatch(/^1 reply could not be delivered since /);
  });

  it('a start line that fails makes no card and no notice', async () => {
    await aReplyThatNeverGoes('on it', 'engine-ack');
    expect(cards()).toEqual([]);
    expect(notices()).toEqual([]);
  });
});
