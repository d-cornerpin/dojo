// A helper's turn on another agent's ASSIGN is rooted in that thread, so a file it writes in that turn is tied to
// the job's task: the engine counts it, and the reviewer sees it unmarked.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));

import { runMigrations } from '../../db/migrations.js';
import { openTurnContext, endTurnContext } from '../turn-context.js';
import { runPreflight } from '../v2/steps/preflight/index.js';
import { executeTool } from '../tools/index.js';
import { effectsFor } from '../tools/registry.js';
import { recordCallsTouched } from '../../work/ledger-store.js';
import { taskToCharge } from '../v2/steps/execute/tracker-counting.js';
import { engineProof, proofFor, proofLines } from '../../work/done/proof.js';
import { freshAgentsDb, preflightCtx, askerDelegates, testDb, HELPER } from './helpers/agent-requests.js';

const THREAD = 'thread-assign-0001';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'assign-proof-'));
const report = path.join(home, 'work', 'figures.md');

beforeEach(() => {
  freshAgentsDb(runMigrations);
  testDb().prepare(`UPDATE agents SET permissions = '{"file_read":"*","file_write":"*"}' WHERE id = ?`).run(HELPER);
});
afterAll(() => { endTurnContext(HELPER); fs.rmSync(home, { recursive: true, force: true }); });

describe("a helper's file on its ASSIGN turn is its task's proof", () => {
  it('the file is tied to the task the ASSIGN carries, counted by the engine and shown unmarked', async () => {
    await askerDelegates('ASSIGN', THREAD);
    const task = (testDb().prepare('SELECT id FROM work WHERE agent_id = ? AND a2a_thread_id = ?').get(HELPER, THREAD) as { id: string }).id;
    const bag = openTurnContext(HELPER);
    expect((await runPreflight(bag, preflightCtx())).directive).toBe('proceed');
    expect(bag.root).toMatchObject({ kind: 'a2a', id: THREAD });

    const call = { id: 'call-write', name: 'file_write', arguments: { path: report, content: 'Total: 42 orders, 3 refunds.' } };
    await executeTool(HELPER, call);
    expect(taskToCharge(HELPER)).toBe(task);
    recordCallsTouched(task, [call], [{ toolCallId: call.id, isError: false }], effectsFor, HELPER);
    endTurnContext(HELPER);

    expect(engineProof(task).map((i) => i.ref)).toEqual([report]);
    expect(proofLines(proofFor(task)).find((l) => l.includes('figures.md'))).not.toContain('could not tie');
  });
});
