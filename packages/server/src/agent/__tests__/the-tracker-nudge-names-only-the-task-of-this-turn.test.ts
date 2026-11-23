// The tracker nudge names only the task carrying this turn: a lived-in box's month-old leftover task is never named on
// a busy turn for a new request, while a stale task linked to the request the turn serves still is.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { testDb } from '../v2/__tests__/helpers/reply-sender.js';
import { AGENT, ownerAsks, respond, world } from './helpers/hand-on-world.js';

/** A claimed task of the main agent, last moved two hours ago, for the message `source`. */
const staleTask = (id: string, title: string, source: string): void => {
  const at = Date.now() - 2 * 3_600_000;
  testDb().prepare(`INSERT INTO work (id, kind, agent_id, requester, requester_id, source_message_id, root_kind, root_id, state, intent, wakes, closes_thread,
      title, opened_at, updated_at) VALUES (?, 'task', ?, 'agent', ?, ?, 'tracker', ?, 'claimed', 'ASSIGN', 0, 0, ?, ?, ?)`).run(id, AGENT, AGENT, source, id, title, at, at);
};
const nudge = async (): Promise<string> => {
  const out = await respond(AGENT, Array.from({ length: 4 }, (_, i) => ['file_read', { path: `/tmp/dojo-no-such-note-${i}.md` }]));
  return (out.state.steerQueue as unknown as { fired: Array<{ floor: string; content: string }> }).fired.find((e) => e.floor === 'tracker-stop-directive')?.content ?? '';
};

beforeEach(() => {
  world();
  staleTask('task-leftover', 'Reply to the old thread', 'm-last-month');
});

describe('the tracker nudge names only the task of this turn', () => {
  it("a new request's busy turn: the nudge fires without naming the leftover", async () => {
    ownerAsks('Tidy up my notes folder.');
    const text = await nudge();
    expect(text).toContain('without an active tracker task');
    expect(text).not.toContain('Reply to the old thread');
  });

  it("the request's own stale task is named", async () => {
    staleTask('task-notes', 'Tidy the notes folder', 'm-owner');
    ownerAsks('Tidy up my notes folder.');
    expect(await nudge()).toContain('"Tidy the notes folder"');
  });
});
