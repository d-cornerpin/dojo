// The owner sees what he is asked to decide: a handed-in task on the board carries its outcome, note and each proof
// item as one line, and its trail reads the hand-in. A task with no hand-in waiting carries none.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import type { Task } from '@dojo/shared';
import { trackerRouter } from '../../../gateway/routes/tracker.js';
import { freshBoard, handedIn, TASK } from './helpers/decision-world.js';

const detail = async (): Promise<Task> => ((await (await trackerRouter.request('/tasks')).json()) as { data: Task[] }).data.find((t) => t.id === TASK)!;

describe('the owner sees the proof he decides', () => {
  it('a handed-in task shows its outcome, note and each proof line; before the hand-in it shows none', async () => {
    freshBoard();
    expect((await detail()).handIn).toBeNull();
    const delivery = await handedIn();
    const { handIn } = await detail();
    expect(handIn).toMatchObject({ outcome: 'finished', note: 'Report sent to the owner' });
    expect(handIn!.proof).toHaveLength(1);
    expect(handIn!.proof[0]).toContain(`delivery ${delivery.slice(0, 8)}`);
    expect(handIn!.proof[0]).toContain('The report has 12 sections');
    const log = await (await trackerRouter.request(`/tasks/${TASK}/log`)).json() as { data: Array<{ entryKind: string; actionTaken: string | null; reason: string | null }> };
    expect(log.data.find((e) => e.entryKind === 'handed_in')).toMatchObject({ actionTaken: 'finished', reason: 'Report sent to the owner' });
  });
});
