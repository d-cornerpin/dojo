// A restart while the owner's progress question carries his parked job: the question is closed on its answer, but the
// job's request is held on its job at boot (not closed on the progress text), and the job's own turn closes it. When
// the job's own stretch dies after a progress line, the job is parked again at boot and resumes from its row.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../db/migrations.js';
import { reconcileOrphanedClaims } from '../../work/orphaned-claims.js';
import { resetWorkingAgentsToIdleAtBoot } from '../agent-status.js';
import { turnContext } from '../turn-context.js';
import { freshAgentsDb, HELPER } from './helpers/agent-requests.js';
import { ownerAsks, stretch, rowOf, delivered, tasksOf } from './helpers/long-job.js';

beforeEach(() => { freshAgentsDb(runMigrations); });

describe('a restart mid-job keeps the job request open', () => {
  it('the carried turn answered the progress question and died: at boot the job request is held, then its job closes it', async () => {
    const job = await ownerAsks('m-1', 'Run the scavenger hunt over the archive');
    await stretch('parks');
    const [task] = tasksOf('m-1');
    const question = await ownerAsks('m-2', 'How far along are you?');
    await stretch('crash', () => {   // "87 clues in", then the process is cut
      const bag = turnContext(HELPER)!;
      delivered(bag.turnNumber!, bag.conversationId ?? null);
    });
    reconcileOrphanedClaims();
    expect(rowOf(question).state).toBe('done');
    expect(rowOf(job).state, 'the progress text is not the job\'s answer').toBe('blocked');
    expect(await stretch('answers')).toMatchObject({ root: 'm-1', servedJob: task });
    expect(rowOf(job).state).toBe('done');
  });

  it('the job\'s own stretch wrote "81 clues in" and died: at boot the job is parked again and its request held, then the job closes it', async () => {
    const job = await ownerAsks('m-1', 'Run the scavenger hunt over the archive');
    await stretch('parks');
    const [task] = tasksOf('m-1');
    await stretch('crash', () => {   // the job's own stretch, picked up from its row: a progress line, then the process is cut
      const bag = turnContext(HELPER)!;
      delivered(bag.turnNumber!, bag.conversationId ?? null);
    });
    expect(rowOf(task!).due, 'the pickup took the due').toBeNull();
    resetWorkingAgentsToIdleAtBoot();
    reconcileOrphanedClaims();
    expect(rowOf(job).state, 'the progress line is not the job\'s answer').toBe('blocked');
    expect(rowOf(task!).due, 'the job is parked again').not.toBeNull();
    expect(await stretch('answers')).toMatchObject({ root: 'm-1', servedJob: task });
    expect(rowOf(job).state).toBe('done');
  });
});
