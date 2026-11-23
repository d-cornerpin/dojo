// N1 as lived: the owner adds to a job while the helper works it, and his agent forwards the add-on as a second
// ASSIGN on the job's thread. The helper's running turn serves it (no "handled on its own turn" label or refusal),
// its COMPLETE goes, and the job's goal carries the add-on, so the review judges the answer against both briefs.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../db/migrations.js';
import { deliverA2AMessage } from '../a2a-transport.js';
import { openTurnContext, endTurnContext } from '../turn-context.js';
import { runPreflight } from '../v2/steps/preflight/index.js';
import { agentsHandlers } from '../tools/cat/agents.js';
import { requestsAwaitingTheirOwnTurn } from '../a2a-own-turn.js';
import { stretch } from './helpers/long-job.js';
import { freshAgentsDb, testDb, askerDelegates, preflightCtx, ASKER, HELPER } from './helpers/agent-requests.js';

const THREAD = 'thread-n1-packing-list';
const ADD_ON = 'Also add a section on where to park at the trailhead.';
const helperSends = (args: Record<string, unknown>) =>
  agentsHandlers['send_to_agent']({ agentId: HELPER, args } as unknown as Parameters<(typeof agentsHandlers)['send_to_agent']>[0]);
const jobGoal = (): string | null => (testDb().prepare('SELECT goal FROM work WHERE kind = ? AND a2a_thread_id = ?').get('task', THREAD) as { goal: string | null }).goal;

beforeEach(() => { freshAgentsDb(runMigrations); endTurnContext(HELPER); });

describe('an add-on sent as a second job goes into the running job', () => {
  it("the helper's running turn serves the add-on, its COMPLETE goes, and the job's goal carries it", async () => {
    await askerDelegates('ASSIGN', THREAD);
    const bag = openTurnContext(HELPER);
    expect((await runPreflight(bag, preflightCtx())).directive).toBe('proceed');
    expect(bag.kind).toBe('a2a');

    const more = await deliverA2AMessage({ intent: 'ASSIGN', threadId: THREAD, requiresResponse: true, payload: ADD_ON, toAgent: HELPER, fromAgent: ASKER });
    expect(more.delivered).toBe(true);
    expect(jobGoal()).toContain('the figure, please');
    expect(jobGoal()).toContain(`Added: ${ADD_ON}`);
    expect(requestsAwaitingTheirOwnTurn(HELPER)).toEqual([]);

    const done = await helperSends({ agent: ASKER, intent: 'COMPLETE', thread_id: THREAD, payload: 'The list, with a parking section.' });
    expect(done.content).not.toMatch(/handled on its own turn/);
    expect(done.isError).toBe(false);
    endTurnContext(HELPER);
  });

  it("a job turn serves a message on its task's thread that came after its pickup", async () => {
    await askerDelegates('ASSIGN', THREAD);
    await stretch('parks');
    const task = (testDb().prepare("SELECT id FROM work WHERE kind = 'task' AND a2a_thread_id = ?").get(THREAD) as { id: string }).id;
    let sent = '';
    const seen = await stretch('stalls', async () => {
      await deliverA2AMessage({ intent: 'ASSIGN', threadId: THREAD, requiresResponse: true, payload: ADD_ON, toAgent: HELPER, fromAgent: ASKER });
      expect(requestsAwaitingTheirOwnTurn(HELPER)).toEqual([]);
      sent = (await helperSends({ agent: ASKER, intent: 'COMPLETE', thread_id: THREAD, payload: 'Done.' })).content;
    });
    expect(seen?.servedJob).toBe(task);
    expect(sent).not.toMatch(/handled on its own turn/);
  });
});
