// An agent the old build left rate-limited is idle after the update, so the one clock can wake it; a due time an
// older build left on a work row is cleared, since no product code wrote one before.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runMigrations, migrationFileNames } from '../migrations.js';
import { freshDoneDb, doneDb, seedTask } from '../../work/done/__tests__/helpers/done-db.js';

const STEP = migrationFileNames().find((f) => f.includes('owed_due_times'))!;
const statusOf = (id: string): string => (doneDb().prepare('SELECT status FROM agents WHERE id = ?').get(id) as { status: string }).status;
const dueOf = (id: string): number | null => (doneDb().prepare('SELECT next_attempt_at AS t FROM work WHERE id = ?').get(id) as { t: number | null }).t;

beforeEach(() => {
  freshDoneDb();
  runMigrations();
  const agent = doneDb().prepare("INSERT INTO agents (id, name, status, classification) VALUES (?, ?, ?, 'standard')");
  agent.run('agent-limited', 'agent-limited', 'rate_limited');
  agent.run('agent-working', 'agent-working', 'working');
  seedTask('task-old-due', 'agent-limited');
  doneDb().prepare('UPDATE work SET next_attempt_at = ? WHERE id = ?').run(Date.now() + 60_000, 'task-old-due');
  doneDb().prepare('DELETE FROM _migrations WHERE name = ?').run(STEP);
  runMigrations();
});

describe('an agent left rate-limited is idle after the update', () => {
  it('the rate-limited agent is idle and another status is untouched', () => {
    expect(statusOf('agent-limited')).toBe('idle');
    expect(statusOf('agent-working')).toBe('working');
  });

  it('a due time an older build left on a work row is cleared', () => {
    expect(dueOf('task-old-due')).toBeNull();
  });
});
