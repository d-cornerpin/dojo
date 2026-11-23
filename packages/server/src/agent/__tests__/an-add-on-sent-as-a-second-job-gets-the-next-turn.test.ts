// N1 as lived: the owner adds to a job while the helper works it, and his agent forwards the add-on as a second
// ASSIGN on the job's thread. The running turn, never shown it, hands in without a refusal; the add-on waits and
// the helper's next turn takes it up and answers it, once. The job's goal carries the add-on for the review.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../db/migrations.js';
import { deliverA2AMessage } from '../a2a-transport.js';
import { openTurnContext, endTurnContext } from '../turn-context.js';
import { runPreflight } from '../v2/steps/preflight/index.js';
import { finalizeTurnRecord } from '../v2/steps/teardown/finalize-record.js';
import { agentsHandlers } from '../tools/cat/agents.js';
import { liveTurnServes } from '../a2a-own-turn.js';
import { stretch } from './helpers/long-job.js';
import { freshAgentsDb, testDb, askerDelegates, preflightCtx, ASKER, HELPER } from './helpers/agent-requests.js';

const THREAD = 'thread-n1-packing-list';
const ADD_ON = 'Also add a section on where to park at the trailhead.';
const helperSends = (payload: string) => agentsHandlers['send_to_agent']({ agentId: HELPER, args: { agent: ASKER, intent: 'COMPLETE', thread_id: THREAD, payload } } as unknown as Parameters<(typeof agentsHandlers)['send_to_agent']>[0]);
const addOnId = (): string => (testDb().prepare('SELECT id FROM messages WHERE agent_id = ? AND content LIKE ?').get(HELPER, `%${ADD_ON}%`) as { id: string }).id;
const answersOnThread = (): string[] => (testDb().prepare(`SELECT content FROM messages WHERE agent_id = ? AND a2a_thread_id = ? AND a2a_intent = 'COMPLETE' ORDER BY seq`)
  .all(ASKER, THREAD) as Array<{ content: string }>).map((r) => r.content);
const servesAddOn = () => liveTurnServes(HELPER, { messageId: addOnId() });
const addOnArrives = () => deliverA2AMessage({ intent: 'ASSIGN', threadId: THREAD, requiresResponse: true, payload: ADD_ON, toAgent: HELPER, fromAgent: ASKER });

/** One helper turn through the real preflight and finalize; `work` runs inside it. Null when nothing was owed. */
async function helperTurn(work: () => Promise<void>): Promise<'served' | null> {
  endTurnContext(HELPER);
  const bag = openTurnContext(HELPER);
  const out = await runPreflight(bag, preflightCtx());
  if (out.directive !== 'proceed' || (!bag.servedRequest && !bag.servedJob)) { endTurnContext(HELPER); return null; }
  await work();
  await finalizeTurnRecord(bag.state!, out.outputs.teardownContext());
  endTurnContext(HELPER);
  return 'served';
}

beforeEach(() => { freshAgentsDb(runMigrations); endTurnContext(HELPER); });

describe('an add-on sent as a second job gets the next turn', () => {
  it('the running turn hands in unrefused, the next turn is shown the add-on and answers it once', async () => {
    await askerDelegates('ASSIGN', THREAD);
    await helperTurn(async () => {
      expect((await addOnArrives()).delivered).toBe(true);
      const first = await helperSends('The list of 30 items.');
      expect(first.isError).toBe(false);
      expect(first.content).not.toMatch(/handled on its own turn/);
    });
    const goal = (testDb().prepare("SELECT goal FROM work WHERE kind = 'task' AND a2a_thread_id = ?").get(THREAD) as { goal: string }).goal;
    expect(goal).toContain(`Added: ${ADD_ON}`);

    let shown: boolean | null = null;
    expect(await helperTurn(async () => { shown = servesAddOn(); expect((await helperSends('Where to park: the north lot.')).isError).toBe(false); })).toBe('served');
    expect(shown).toBe(true);
    expect(await helperTurn(async () => { await helperSends('again'); })).toBeNull();
    for (const part of ['The list of 30 items.', 'Where to park']) expect(answersOnThread().filter((c) => c.includes(part))).toHaveLength(1);
  });

  it('an add-on that lands during a job turn waits for a turn that is shown it', async () => {
    await askerDelegates('ASSIGN', THREAD);
    await stretch('parks');
    let sent = '';
    await stretch('stalls', async () => {
      await addOnArrives();
      expect(servesAddOn()).toBe(false);
      sent = (await helperSends('Done.')).content;
    });
    expect(sent).not.toMatch(/handled on its own turn/);
    let shown: boolean | null = null;
    expect(await helperTurn(async () => { shown = servesAddOn(); })).toBe('served');
    expect(shown).toBe(true);
  });
});
