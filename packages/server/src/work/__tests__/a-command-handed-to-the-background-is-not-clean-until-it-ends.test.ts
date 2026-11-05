// v3.5 field fix 3, re-review 4 N4: A COMMAND HANDED TO THE BACKGROUND IS NOT "exit 0" UNTIL IT ENDS.
//
// When a person's message arrives during a long command, the exec door hands the call back
// (`agent/tools/person-first.ts`) and the result the round holds is the hand-back notice, which carries
// no failure line. The ledger read that as a clean exit, so the PM's review could show a build that
// later failed as `exit 0`. Now the hand-back is marked on the call itself (structurally, by its call
// id, never by its words): the ledger row says "still running" and is updated with the real exit
// status when the command ends.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-ledger-handback', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/effects/proc-tree.js', () => ({ handToBackground: () => false }));
vi.mock('../../agent/wake-with-notice.js', () => ({ tellAgentAndWake: vi.fn(async () => {}), requesterReachSentence: vi.fn(async () => '') }));
vi.mock('../../services/imessage-bridge.js', () => ({ getTurnScopedImRecipient: () => null }));

import { runMigrations } from '../../db/migrations.js';
import { seedTrackerTask } from './work-fixture.js';
import { recordCallsTouched } from '../ledger-store.js';
import { ledgerWorkEntries } from '../ledger-read.js';
import { personFirstFor } from '../../agent/tools/person-first.js';
import { handBackText } from '../../agent/tools/process-run.js';
import { runWithToolCallId } from '../../agent/turn-state.js';

const WORKER = 'handback-worker';
const TASK = 'task-handback';
const SHELL = [{ kind: 'shell' as const, from: 'args.script' }];
const effectsOf = (name: string) => (name === 'shell' ? SHELL : undefined);
const db = (): Database.Database => mockDb.current!;
const statusOf = (): string | null => {
  const r = db().prepare("SELECT detail FROM work_ledger WHERE work_id = ? AND item_key LIKE 'cmd:%'").get(TASK) as { detail: string | null } | undefined;
  return r?.detail ?? null;
};
const settle = () => new Promise((r) => setTimeout(r, 10));

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare("INSERT INTO agents (id, name, classification) VALUES (?, ?, 'apprentice')").run(WORKER, WORKER);
  seedTrackerTask(db(), { id: TASK, agentId: WORKER, status: 'in_progress', title: 'build the site', opened_at: Date.now(), updated_at: Date.now(), priority: 'normal' } as never);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

/** The exec door's hand-back, as `runProcess` does it, inside the call's own execution context. */
async function handBack(callId: string, outcome: Promise<string>): Promise<string> {
  return runWithToolCallId(WORKER, callId, async () => {
    personFirstFor(WORKER, 'shell script "npm run build"').handedBack(4242, outcome);
    return handBackText(4242);
  });
}
const record = (callId: string, content: string) => recordCallsTouched(TASK,
  [{ id: callId, name: 'shell', arguments: { script: 'npm run build' } }],
  [{ toolCallId: callId, isError: false, content }], effectsOf, WORKER);

describe('N4: a backgrounded command is "still running" on the ledger, then its real exit status', () => {
  it('a build that later FAILS is never shown clean', async () => {
    let finish: (s: string) => void = () => {};
    const outcome = new Promise<string>((r) => { finish = r; });
    const text = await handBack('call-bg-1', outcome);
    record('call-bg-1', text);
    expect(statusOf()).toBe('still running');
    expect(ledgerWorkEntries(TASK).find((e) => e.kind === 'command')?.status).toBe('still running');
    finish('command_failed: exit 2 (build error)');
    await settle();
    expect(statusOf()).toBe('exit 2 (build error)');
  });

  it('a build that ends clean is exit 0 once it ends', async () => {
    let finish: (s: string) => void = () => {};
    const outcome = new Promise<string>((r) => { finish = r; });
    record('call-bg-2', await handBack('call-bg-2', outcome));
    expect(statusOf()).toBe('still running');
    finish('built in 41s');
    await settle();
    expect(statusOf()).toBe('exit 0');
  });

  it('a command that ended before the ledger was written goes straight to its real status', async () => {
    const outcome = Promise.resolve('command_failed: exit 1');
    const text = await handBack('call-bg-3', outcome);
    await settle();
    record('call-bg-3', text);
    await settle();
    expect(statusOf()).toBe('exit 1');
  });

  it('a later inline run of the same command is not overwritten by the earlier one ending', async () => {
    let finish: (s: string) => void = () => {};
    const outcome = new Promise<string>((r) => { finish = r; });
    record('call-bg-4', await handBack('call-bg-4', outcome));
    await settle();
    record('call-inline-5', 'ok');   // the same command, run again inline and clean
    finish('command_failed: exit 9');
    await settle();
    expect(statusOf()).toBe('exit 0');
  });

  it('an outcome that rejects is a failure, never exit 0', async () => {
    let fail: (e: Error) => void = () => {};
    const outcome = new Promise<string>((_r, j) => { fail = j; });
    record('call-bg-7', await handBack('call-bg-7', outcome));
    fail(new Error('runner crashed'));
    await settle();
    expect(statusOf()).toBe('ended without reporting a result');
  });

  it('a result that is not a hand-back is read as before (the mark is the call, never the words)', () => {
    record('call-plain-6', handBackText(4242));   // the same words, but no hand-back happened on this call
    expect(statusOf()).toBe('exit 0');
  });
});
