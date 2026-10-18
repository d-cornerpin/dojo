// t207 (D6) — THE CHAT BACKFILL ENDS WITH THE HISTORY, NOT AT A PAGE COUNT.
// A pile of machine traffic can sit on top of the conversation. The backfill keeps fetching older pages until
// real conversation renders or history ends; it used to give up after 60 extra pages.
import { describe, it, expect } from 'vitest';
import { classifyMessageForDisplay, type Message } from '@dojo/shared';
import { backfillUntilRenderable } from '../lib/chat-history-backfill';

const visible = (i: number): Message => ({
  id: `m-${String(i).padStart(6, '0')}`, agentId: 'a', role: i % 2 ? 'assistant' : 'user', content: `hello ${i}`,
  createdAt: '2023-11-14T22:13:20.000Z', turnNumber: i, lane: 'owner',
} as unknown as Message);
const machine = (i: number): Message => ({
  id: `m-${String(i).padStart(6, '0')}`, agentId: 'a', role: 'assistant', content: `[A2A:STATUS thread:abc from:Peer] note ${i}`,
  createdAt: '2023-11-14T22:13:20.000Z', turnNumber: i, lane: 'a2a',
} as unknown as Message);
const rendersInRegular = (m: Message): boolean => classifyMessageForDisplay(m).tier === 'user-visible';

describe('t207 — chat history backfill', () => {
  it('digs past 100 pages of machine traffic to the conversation underneath', async () => {
    const PAGE = 200;
    const all: Message[] = [];
    for (let i = 0; i < 20; i++) all.push(visible(i));
    for (let i = 20; i < 20 + PAGE * 101; i++) all.push(machine(i));
    expect(rendersInRegular(all[all.length - 1]), 'precondition: machine rows do not render').toBe(false);
    let calls = 0;
    const fetchOlder = async (oldestId: string): Promise<{ ok: boolean; data?: Message[] }> => {
      calls++;
      const at = all.findIndex((m) => m.id === oldestId);
      return { ok: true, data: all.slice(Math.max(0, at - PAGE), at) };
    };
    const out = await backfillUntilRenderable(all.slice(-PAGE), false, fetchOlder, () => true);
    expect(out).not.toBeNull();
    expect(calls, 'more than 60 pages were fetched').toBeGreaterThan(60);
    expect(out!.filter(rendersInRegular).length, 'the conversation was found').toBeGreaterThanOrEqual(15);
  });

  it('stops when history ends, and when the load is cancelled', async () => {
    const first = [machine(100)];
    expect(await backfillUntilRenderable(first, false, async () => ({ ok: true, data: [] }), () => true)).toEqual(first);
    expect(await backfillUntilRenderable(first, false, async () => ({ ok: true, data: [machine(99)] }), () => false)).toBeNull();
  });

  it('a server that keeps returning the same page cannot loop it for ever', async () => {
    const first = [machine(100)];
    const out = await backfillUntilRenderable(first, false, async () => ({ ok: true, data: first }), () => true);
    expect(out).toEqual(first);
  });
});
