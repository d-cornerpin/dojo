// A reply that still cannot get through after all its tries is told to the owner on one dashboard card per agent
// that stays until he dismisses it: each new failure raises its count on the same card, and after he dismisses it
// only a new failure brings it back, counting afresh. No text goes to the owner. A failed start line is not told.
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
import { dismissOwnerNotice } from '../../../healer/owner-notices.js';
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

const served = () => servedOwnerNotices().filter((c) => c.cardKey === KEY).map((c) => c.words);
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
  it('one failure: one card that stays, naming the person, the channel, a plain reason and that it is in the chat', async () => {
    await aReplyThatNeverGoes('the table is booked for eight');
    expect(cards()).toHaveLength(1);
    expect(cards()[0]).toMatchObject({ cardClass: 'action' });
    expect(cards()[0].error).toMatch(new RegExp(`^1 reply could not be delivered since [A-Z][a-z]{2} \\d+, \\d{4}, .+\\. Latest: iMessage to \\${PERSON} \\(Messages could not send it\\)\\. It is in the chat\\.$`));
    expect(served()).toEqual([cards()[0].error]);
  });

  it('five in an evening: one card, its count rising to 5, served again at each load, and no text to the owner', async () => {
    for (let i = 1; i <= 5; i++) await aReplyThatNeverGoes(`answer ${i}`);
    expect(cards().map((c) => String(c.error).split(' could')[0])).toEqual(['1 reply', '2 replies', '3 replies', '4 replies', '5 replies']);
    expect(served()).toHaveLength(1);
    expect(served()[0]).toMatch(/^5 replies could not be delivered since /);
    expect(seen.alerts).toEqual([]);
    expect(imessage.send.mock.calls.filter(([to]) => to === OWNER)).toEqual([]);
  });

  it('he dismisses it: nothing new, no card; one more failure the next day is a new card counting 1', async () => {
    for (let i = 1; i <= 5; i++) await aReplyThatNeverGoes(`answer ${i}`);
    dismissOwnerNotice(KEY);
    expect(served()).toEqual([]);
    // The evening is now yesterday.
    testDb().prepare("UPDATE deliveries SET updated_at = datetime('now', '-1 day')").run();
    seen.frames = [];
    await aReplyThatNeverGoes('the next day');
    expect(cards()).toHaveLength(1);
    expect(cards()[0].error).toMatch(/^1 reply could not be delivered since /);
    expect(served()).toEqual([cards()[0].error]);
  });

  it('a start line that fails makes no card and no notice', async () => {
    await aReplyThatNeverGoes('on it', 'engine-ack');
    expect(cards()).toEqual([]);
    expect(notices()).toEqual([]);
  });
});
