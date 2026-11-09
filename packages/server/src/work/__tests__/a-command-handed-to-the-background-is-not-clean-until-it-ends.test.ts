// v3.5 field fix 3, re-review 4 N4: A COMMAND HANDED TO THE BACKGROUND IS NOT "exit 0" UNTIL IT ENDS.
//
// When a person's message arrives during a long command, the exec door hands the call back
// (`agent/tools/person-first.ts`) and the result the round holds is the hand-back notice, which carries
// no failure line. The ledger read that as a clean exit, so the PM's review could show a build that
// later failed as `exit 0`. Now the hand-back is marked on the call itself (structurally, by its call
// id, never by its words): the ledger row says "still running" and is updated with the real exit
// status when the command ends.
//
// RE-REVIEW 5 (P1): the link lives on the rows (migration 214: the call id on the hand-off's
// `background_commands` row and on the ledger row), not in a map with a one-hour drop; and a restart
// settles every row still running as ended by the restart, in the same transaction as its notice.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
vi.mock('../../agent/effects/proc-tree.js', () => ({ handToBackground: () => true }));
vi.mock('../../agent/wake-with-notice.js', () => ({ tellAgentAndWake: vi.fn(async () => {}), requesterReachSentence: vi.fn(async () => '') }));
vi.mock('../../services/imessage-bridge.js', () => ({ getTurnScopedImRecipient: () => null }));
const noticeFails = { on: false };
vi.mock('../../agent/agent-notice.js', async (orig) => {
  const real = await orig<{ postAgentNotice: (o: unknown) => string | null }>();
  return { ...real, postAgentNotice: (o: unknown) => (noticeFails.on ? null : real.postAgentNotice(o)) };
});
const legacyHome = { dir: '' };
vi.mock('../../home.js', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const p = await import('node:path');
  return { ...real, dojoDir: (...seg: string[]) => p.join(legacyHome.dir, '.dojo', ...seg) };
});

import { runMigrations } from '../../db/migrations.js';
import { seedTrackerTask } from './work-fixture.js';
import { recordCallsTouched, ledgerWorkEntries } from '../ledger-store.js';
import { personFirstFor } from '../../agent/tools/person-first.js';
import { handBackText } from '../../agent/tools/process-run.js';
import { runWithToolCallId } from '../../agent/turn-state.js';
import { tellAgentsOfCommandsCutByRestart, LEGACY_BACKGROUND_COMMANDS_FILE } from '../../agent/background-commands.js';
import { recordTouched } from '../ledger-store.js';
import { validationMeasureLines } from '../../tracker/job-loop-facts.js';

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
  legacyHome.dir = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'bg-legacy-'));
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare("INSERT INTO agents (id, name, classification) VALUES (?, ?, 'apprentice')").run(WORKER, WORKER);
  seedTrackerTask(db(), { id: TASK, agentId: WORKER, status: 'in_progress', title: 'build the site', opened_at: Date.now(), updated_at: Date.now(), priority: 'normal' } as never);
});
afterEach(() => { noticeFails.on = false; mockDb.current?.close(); mockDb.current = null; });

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

  it('re-review 5 (P1a): a restart leaves no "still running" row', async () => {
    record('call-bg-r1', await handBack('call-bg-r1', new Promise<string>(() => {})));   // never ends: the restart cuts it
    expect(statusOf()).toBe('still running');
    expect(await tellAgentsOfCommandsCutByRestart()).toBe(1);
    expect(statusOf()).toBe('ended by a Dojo restart, no result');
    expect((db().prepare("SELECT COUNT(*) AS n FROM work_ledger WHERE detail = 'still running'").get() as { n: number }).n).toBe(0);
  });

  it('re-review 5 (P1b): a command whose ledger write comes more than an hour after it ended, with another hand-off between, keeps its real status', async () => {
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(t0);
      const text = await handBack('call-bg-late', Promise.resolve('command_failed: exit 2 (build error)'));
      await settle();                                                     // it ended at once
      vi.setSystemTime(t0 + 65 * 60 * 1000);
      await handBack('call-bg-other', new Promise<string>(() => {}));     // another hand-off on the box
      vi.setSystemTime(t0 + 3 * 60 * 60 * 1000);
      record('call-bg-late', text);                                       // the round's ledger step, after a 3-hour batch
      expect(statusOf()).toBe('exit 2 (build error)');
    } finally { vi.useRealTimers(); }
  });

  it('a result that is not a hand-back is read as before (the mark is the call, never the words)', () => {
    record('call-plain-6', handBackText(4242));   // the same words, but no hand-back happened on this call
    expect(statusOf()).toBe('exit 0');
  });
});

describe('re-review 5 LOWs', () => {
  it('an overflowing review page counts a still-running command as still running, never as failed', () => {
    const keys = Array.from({ length: 400 }, (_v, i) => `cmd:npm run build --shard ${i}`);
    recordTouched(TASK, 'shell', keys, Date.now(), 'still running');
    const lines = validationMeasureLines(TASK, 300);
    expect(lines).toMatch(/more commands still running/);
    expect(lines).not.toMatch(/that failed/);
  });

  it('the old restart file is deleted only after its notices are saved', async () => {
    const file = path.join(legacyHome.dir, '.dojo', 'data', LEGACY_BACKGROUND_COMMANDS_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify([{ agentId: WORKER, pid: 77, what: 'shell script "make"', startedAt: Date.now() }]));
    noticeFails.on = true;
    expect(await tellAgentsOfCommandsCutByRestart()).toBe(0);
    expect(fs.existsSync(file)).toBe(true);                 // nothing was told, so it is read again next boot
    noticeFails.on = false;
    expect(await tellAgentsOfCommandsCutByRestart()).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
  });
});
