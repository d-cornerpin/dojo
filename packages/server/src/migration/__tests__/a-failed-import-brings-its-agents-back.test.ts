// ════════════════════════════════════════════════════════════════════════════════════════
// Final round (owner rule: the Dojo does the work). The import used to TERMINATE every idle or working agent before it
// swapped the data folder. The termination was written into the very database a failed import puts back, so every
// agent came back terminated. Now the import only STOPS the runs in flight (the database must close), and a failed
// import brings those agents back: the stop is lifted (the owner did not stop them), and each is woken to carry on.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({ getDb: () => mockDb.current!, getDbPath: () => ':memory:' }));
const stopped = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock('../../agent/runtime.js', () => ({ stopAgent: (id: string) => { stopped.ids.push(id); } }));

import { activeRuns, stoppedAgents, pendingWakeups } from '../../agent/shared-state.js';
import { stopAgentRunsForImport, resumeAgentsAfterFailedImport, noteOwnerStop } from '../import-agents.js';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  mockDb.current.exec("CREATE TABLE agents (id TEXT PRIMARY KEY, status TEXT, config TEXT, updated_at TEXT)");
  mockDb.current.prepare("INSERT INTO agents (id, status, config) VALUES ('a', 'working', ?), ('b', 'idle', '{}')").run('{}');
  stopped.ids = []; activeRuns.clear(); stoppedAgents.clear(); pendingWakeups.clear();
});
afterEach(() => { mockDb.current?.close(); });

describe('a failed import brings its agents back', () => {
  it('only the runs in flight are stopped, and no agent is terminated', () => {
    activeRuns.add('a');
    expect(stopAgentRunsForImport()).toEqual(['a']);
    expect(stopped.ids).toEqual(['a']);
    expect(mockDb.current!.prepare('SELECT status FROM agents ORDER BY id').all()).toEqual([{ status: 'working' }, { status: 'idle' }]);
  });

  it('after a failed import the stop is lifted and the agent woken to carry on', () => {
    stoppedAgents.add('a');
    resumeAgentsAfterFailedImport(['a']);
    expect(stoppedAgents.has('a')).toBe(false);
    expect(pendingWakeups.has('a')).toBe(true);
  });

  it('a stop the owner pressed before the import is never lifted by a failed import', () => {
    activeRuns.add('a'); activeRuns.add('b');
    stoppedAgents.add('a');   // the owner's stop; the run is still unwinding
    const ids = stopAgentRunsForImport();
    expect(ids).toEqual(['b']);
    expect(stopped.ids).toEqual(['a', 'b']);   // both runs still stop for the database swap
    resumeAgentsAfterFailedImport(ids);
    expect(stoppedAgents.has('a')).toBe(true);
    expect(pendingWakeups.has('a')).toBe(false);
  });

  it('a stop the owner pressed during the import is never lifted by a failed import', () => {
    activeRuns.add('a');
    const ids = stopAgentRunsForImport();
    expect(ids).toEqual(['a']);
    stoppedAgents.add('a'); noteOwnerStop('a');   // the stop route: stopAgent, then the note
    resumeAgentsAfterFailedImport(ids);
    expect(stoppedAgents.has('a')).toBe(true);
    expect(pendingWakeups.has('a')).toBe(false);
  });
});
