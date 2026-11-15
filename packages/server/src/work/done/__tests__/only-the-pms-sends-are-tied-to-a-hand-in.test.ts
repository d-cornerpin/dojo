// A send is tied to the hand-in it asks about only when the project manager sends it: the main agent deciding an
// escalated hand-in sends about other things without its receipts being stamped with that task.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', async () => (await import('./helpers/ladder-world.js')).wsMock());
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.mock('../../../tracker/pm-agent.js', async (orig) => ({ ...(await orig<object>()), armDebouncedReview: vi.fn() }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { whoDecides } from '../who-decides.js';
import { runPMReview } from '../../../tracker/pm-agent.js';
import { freshBoard, handedIn, call, PM, MAIN, OTHER, TASK } from './helpers/decision-world.js';
import { pmCanRun, resetLadderWorld } from './helpers/ladder-world.js';
import { doneDb } from './helpers/done-db.js';

beforeEach(() => resetLadderWorld());

describe('only the PM\'s sends are tied to a hand-in', () => {
  it('the main agent deciding a hand-in sends about something else, and its receipt names no task', async () => {
    freshBoard(); pmCanRun(PM);
    await handedIn();
    await runPMReview();
    await runPMReview();
    expect(whoDecides(TASK)).toEqual({ kind: 'agent', agentId: MAIN });
    const r = await call(MAIN, 'send_to_agent', { agent: OTHER, intent: 'QUESTION', payload: 'Is the printer on the second floor working again?' });
    expect(r.isError, r.content).toBe(false);
    const receipt = doneDb().prepare("SELECT task_id FROM tool_receipts WHERE agent_id = ? AND tool = 'send_to_agent' ORDER BY rowid DESC LIMIT 1").get(MAIN) as { task_id: string | null };
    expect(receipt.task_id).toBeNull();
  });
});
