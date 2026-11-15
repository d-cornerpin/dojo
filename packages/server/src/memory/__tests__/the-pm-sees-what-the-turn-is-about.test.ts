// The project manager sees what the turn is about (an ordinary day): after many reviews of other work, a review
// shows its own report, the owner's pinned memories and the recent conversation, and no earlier report or proof
// read. Two reviews with no conversation between share every message before the report, and a later call of
// the same turn appends to the first.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.mock('../../gateway/ws.js', async () => (await import('../../work/done/__tests__/helpers/ladder-world.js')).wsMock());
vi.mock('../../agent/runtime.js', async () => (await import('../../work/done/__tests__/helpers/ladder-world.js')).runtimeMock());
vi.mock('../../tracker/pm-agent.js', async (orig) => ({ ...(await orig<object>()), armDebouncedReview: vi.fn() }));
vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

import { runPMReview } from '../../tracker/pm-agent.js';
import { assembleContext } from '../assembler.js';
import { renderTokens } from '../lanes.js';
import { insertMessage } from '../message-store.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';
import { freshBoard, call, deliveredToOwner, PM, WORKER } from '../../work/done/__tests__/helpers/decision-world.js';
import { doneDb } from '../../work/done/__tests__/helpers/done-db.js';
import { pmCanRun, turn } from '../../work/done/__tests__/helpers/ladder-world.js';

type View = Awaited<ReturnType<typeof assembleContext>>['messages'];
const text = (v: View): string => v.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

async function handIn(id: string, title: string): Promise<void> {
  const at = Date.now() - 60_000;
  doneDb().prepare(
    `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, goal, opened_at, updated_at)
     VALUES (?, 'task', ?, 'owner', 'tracker', ?, 'claimed', 'task', 1, 0, ?, 'The owner has it', ?, ?)`,
  ).run(id, WORKER, id, title, at, at);
  const r = await call(WORKER, 'work_update', { action: 'hand_in', task_id: id, outcome: 'finished', proof: [{ kind: 'delivery', ref: deliveredToOwner() }], note: 'Sent' });
  if (r.isError) throw new Error(r.content);
}

/** The PM's review turn as the runtime runs it: assemble on the report, then the turn's own proof read. */
function reviewTurns(views: View[], later: View[]): void {
  let n = 0;
  turn.during = async () => {
    n += 1;
    const ctx = openTurnContext(PM);
    ctx.turnNumber = n;
    const report = doneDb().prepare("SELECT id FROM messages WHERE agent_id = ? AND origin_intent = 'pm_review' ORDER BY seq DESC LIMIT 1").get(PM) as { id: string };
    const assemble = async (): Promise<View> => (await assembleContext(PM, 'm', { latestUserSource: null, isEngineTurn: true, engineEventKeepFullId: report.id })).messages;
    views.push(await assemble());
    const callId = `call-${n}`;
    insertMessage({ agentId: PM, role: 'assistant', turnNumber: n, subjectKind: 'engine_event', content: JSON.stringify([{ type: 'tool_use', id: callId, name: 'work_validate', input: { action: 'open_proof' } }]) });
    insertMessage({ agentId: PM, role: 'tool', turnNumber: n, subjectKind: 'engine_event', content: JSON.stringify([{ type: 'tool_result', tool_use_id: callId, content: `PROOF READ ${n}: ${'a line of the delivered report. '.repeat(200)}` }]) });
    later.push(await assemble());
    insertMessage({ agentId: PM, role: 'assistant', turnNumber: n, subjectKind: 'engine_event', content: `Review ${n} done.` });
    endTurnContext(PM);
  };
}

describe('the PM sees what the turn is about', () => {
  it('an ordinary review holds its report, the pinned rule and the conversation, and nothing of older reviews', async () => {
    freshBoard(); pmCanRun(PM);
    doneDb().prepare('UPDATE models SET context_window = 128000').run();
    doneDb().prepare(`INSERT INTO vault_entries (id, agent_id, type, content, confidence, is_permanent, is_pinned, is_obsolete, created_at, updated_at)
      VALUES ('pin-rule', 'manual', 'procedure', 'From now on, send back any hand-in without a test.', 1.0, 1, 1, 0, datetime('now'), datetime('now'))`).run();
    insertMessage({ agentId: PM, role: 'user', content: 'Which reports are still open?', conversationId: 'conv-owner-pm', senderId: 'owner', authorized: true });
    insertMessage({ agentId: PM, role: 'assistant', content: 'Two reports wait for my review.', conversationId: 'conv-owner-pm' });
    const views: View[] = [], later: View[] = [];
    reviewTurns(views, later);
    for (let i = 1; i <= 30; i += 1) {
      await handIn(`task-${i}`, `Old project report ${i}`);
      await runPMReview();
      await call(PM, 'work_validate', { action: 'decide', task_id: `task-${i}`, verdict: 'send_back', reason: 'Not yet' });
    }
    for (const t of ['Ordinary hand-in A', 'Ordinary hand-in B']) {
      await handIn(t.replace(/ /g, '-'), t);
      await runPMReview();
      await call(PM, 'work_validate', { action: 'decide', task_id: t.replace(/ /g, '-'), verdict: 'send_back', reason: 'Not yet' });
    }
    const [a, b] = views.slice(-2);
    const seen = text(b);
    expect(seen).toContain('Ordinary hand-in B');
    expect(seen, 'the pinned rule').toContain('From now on, send back any hand-in without a test.');
    expect(seen, 'the recent conversation').toContain('Which reports are still open?');
    expect(seen, 'an earlier report').not.toContain('Old project report');
    expect(seen, 'an earlier proof read').not.toContain('PROOF READ');
    const at = (v: View, title: string): number => v.findIndex((m) => text([m]).includes(title));
    expect(at(b, 'Ordinary hand-in B')).toBe(at(a, 'Ordinary hand-in A'));
    expect(b.slice(0, at(b, 'Ordinary hand-in B')), 'the cached part moved between two reviews').toEqual(a.slice(0, at(a, 'Ordinary hand-in A')));
    expect(later[later.length - 1].slice(0, b.length - 1), 'a later call of the same turn appends').toEqual(b.slice(0, -1));
    expect(renderTokens(b), 'the view of an ordinary review, without instructions and tools').toBeLessThan(3_000);
  });
});
