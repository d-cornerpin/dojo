// v3.5 field fix 3. OWNER RULING "Your messages come first": while a long shell command runs, the
// owner's new message must still get answered. The command keeps running in the background; the turn
// is not held on it, and the agent gets the result when it ends.
//
// RE-REVIEW 3 (T1, M2, L1, L2). The first build handed back whenever ANY person's message was open,
// and a turn claims one ask at pickup, so the owner's second bubble left one open: `echo hi` came
// back "still running" and two dependent steps ran out of order. Now only a message that ARRIVES
// after the command started hands it back (heard on the runtime's arrival event, no poll); the
// hand-back says the result is not available yet; the command becomes the agent's background job
// (a later turn's failure does not end it, the Stop does, the agent has its pid); its result wakes
// the agent as `background_command_done`; a restart that cuts it is told to the agent.
//
// Driven through the real `shell` handler. Children wait on files the test creates, so nothing here
// bets on wall time.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AGENT = 'agent-bg';
vi.mock('../../effects/capability.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  requireAuthorized: () => ({ agentId: 'agent-bg' }),
}));
const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-bg-cmd', 'dojo.db'),
  };
});
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => undefined }) }));

import { runMigrations } from '../../../db/migrations.js';
import { fsHandlers } from '../cat/fs.js';
import { noteArrivalWhileBusy } from '../../shared-state.js';
import { backgroundCommandsOf, endAgentCommands } from '../../effects/proc-tree.js';
import { recordHandOff, tellAgentsOfCommandsCutByRestart } from '../../background-commands.js';
import { openAsk } from '../../../work/store.js';
import { authorizeExecShapedCall, grantFor } from '../../brokers/index.js';
import { clearPlatformConfigCache } from '../../../config/platform.js';

const db = (): Database.Database => mockDb.current!;
let n = 0;
/** What production stores as `created_at` for a row written at `ms`: whole seconds (`NOW_MS`). */
const storedAt = (ms: number): number => Math.floor(ms / 1000) * 1000;
/** A person's message on the dashboard, with its own open ask, as production stores it at `ms`. */
function personWrites(ms: number): void {
  const atMs = storedAt(ms);
  const id = `msg-${++n}`;
  db().prepare(`INSERT INTO messages (id, agent_id, role, content, lane, conversation_id, channel, created_at) VALUES (?, ?, 'user', 'and thanks', 'owner', 'conv-1', 'dashboard', ?)`)
    .run(id, AGENT, atMs);
  openAsk({ agentId: AGENT, messageId: id, conversationId: 'conv-1', requesterId: 'owner', openedAt: atMs, title: 'and thanks' });
}
const shell = async (script: string): Promise<string> =>
  (await fsHandlers.shell({ agentId: AGENT, args: { script, timeout: 60_000 } } as never)).content;
function gate(): { flag: string; release: () => void; dir: string } {
  const dir = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'bg-cmd-'));
  const flag = path.join(dir, 'go');
  return { dir, flag, release: () => fs.writeFileSync(flag, '') };
}
const waitFor = async (pred: () => boolean): Promise<void> => { while (!pred()) await new Promise((r) => setTimeout(r, 20)); };
const engineEvents = (intent: string): string[] => (db().prepare(
  'SELECT content FROM messages WHERE agent_id = ? AND origin_intent = ? ORDER BY seq',
).all(AGENT, intent) as Array<{ content: string }>).map((r) => r.content);

beforeEach(() => {
  mockDb.current?.close();
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Main', 'working', '1970-01-01')`).run(AGENT);
  db().prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES ('conv-1', ?, 'dashboard', 'owner')`).run(AGENT);
  db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(AGENT);
  clearPlatformConfigCache();
});

describe('a person\'s message that was already open never sends a command to the background', () => {
  it('THE RED (T1): a message open before the call: `echo hi` returns inline', async () => {
    personWrites(Date.now() - 1000);
    expect(await shell('echo hi')).toContain('hi');
    expect(await shell('echo hi')).not.toMatch(/background/);
  });

  it('THE RED (T1): two dependent steps with an early-open message both run inline, in order', async () => {
    personWrites(Date.now() - 1000);
    const g = gate();
    const log = path.join(g.dir, 'log');
    const step1 = await shell(`sleep 0.2; echo step1 >> '${log}'`);
    const step2 = await shell(`echo "step2 saw: $(cat '${log}')"`);
    expect(step1).not.toMatch(/background/);
    expect(step2).toContain('step2 saw: step1');
    fs.rmSync(g.dir, { recursive: true, force: true });
  });

  it('something else arriving mid-command (no new person message) does not hand it back', async () => {
    personWrites(Date.now() - 1000);
    const g = gate();
    const run = shell(`while [ ! -f '${g.flag}' ]; do sleep 0.05; done; echo finished`);
    noteArrivalWhileBusy(AGENT);                      // a peer or an event, not a person
    g.release();
    expect(await run).toContain('finished');
    fs.rmSync(g.dir, { recursive: true, force: true });
  });
});

describe('a person\'s message arriving mid-command hands it back, and the command has an owner', () => {
  it('THE RED (re-review 4, N1): a message in the SAME second as the command\'s start, stored in whole seconds, hands it back', async () => {
    const g = gate();
    const started = Date.now();
    const run = shell(`while [ ! -f '${g.flag}' ]; do sleep 0.05; done; echo finished-late`);
    await new Promise((r) => setTimeout(r, 50));
    personWrites(started);                            // created_at = the start's own second, so below the start in ms
    noteArrivalWhileBusy(AGENT);
    expect(await run).toMatch(/moved to the background/);
    g.release();
    await waitFor(() => engineEvents('background_command_done').length > 0);
    fs.rmSync(g.dir, { recursive: true, force: true });
  });

  it('THE RED (re-review 4, N2): the hand-back names the whole group; `kill -- -<pid>` through the shell ends a two-step script, and the shell door allows it', async () => {
    const run = shell('sleep 30; echo two-steps-done');
    await new Promise((r) => setTimeout(r, 50));
    personWrites(Date.now());
    noteArrivalWhileBusy(AGENT);
    const text = await run;
    const pid = Number(/process group (\d+)/.exec(text)![1]);
    expect(text).toContain(`kill -- -${pid}`);
    expect(authorizeExecShapedCall(grantFor(AGENT), 'shell', `kill -- -${pid}`).allowed).toBe(true);
    await shell(`kill -- -${pid}`);
    await waitFor(() => !backgroundCommandsOf(AGENT).some((j) => j.pid === pid));   // the group's sleep ended with its leader
    await waitFor(() => engineEvents('background_command_done').length > 0);
    const result = engineEvents('background_command_done')[0].split('Its result:')[1];
    expect(result).toMatch(/command_failed/);                 // ended by the signal, not run to its end
    expect(result).not.toContain('two-steps-done');
  });

  it('the result keeps its lines (re-review 4, LOW)', async () => {
    const g = gate();
    const run = shell(`while [ ! -f '${g.flag}' ]; do sleep 0.05; done; printf 'line-one\\nline-two\\n'`);
    await new Promise((r) => setTimeout(r, 50));
    personWrites(Date.now());
    noteArrivalWhileBusy(AGENT);
    await run;
    g.release();
    await waitFor(() => engineEvents('background_command_done').length > 0);
    expect(engineEvents('background_command_done')[0]).toMatch(/line-one\nline-two/);
    expect(db().prepare('SELECT COUNT(*) AS n FROM background_commands').get()).toEqual({ n: 0 });   // cleared once saved
    fs.rmSync(g.dir, { recursive: true, force: true });
  });

  it('hands back with the consequence and the pid; a later failed turn does not end it; its result wakes the agent', async () => {
    const g = gate();
    const run = shell(`while [ ! -f '${g.flag}' ]; do sleep 0.05; done; echo finished-late`);
    await new Promise((r) => setTimeout(r, 50));      // the command has started
    personWrites(Date.now());                         // the owner writes during it (stored in whole seconds)
    noteArrivalWhileBusy(AGENT);
    const text = await run;
    expect(text).toMatch(/moved to the background \(pid \d+\)/);
    expect(text).toMatch(/Its result is NOT available yet\. Nothing that depends on this command's result can run now/);
    const pid = Number(/pid (\d+)/.exec(text)![1]);
    await waitFor(() => backgroundCommandsOf(AGENT).some((j) => j.pid === pid));
    endAgentCommands(AGENT);                          // a later turn throws: its teardown
    g.release();
    await waitFor(() => engineEvents('background_command_done').length > 0);
    expect(engineEvents('background_command_done')[0]).toContain('finished-late');
    expect(engineEvents('background_command_done')[0]).toContain(`pid ${pid}`);
    fs.rmSync(g.dir, { recursive: true, force: true });
  });

  it('a restart cut a handed-back command (a database row, migration 213): the agent is told which, and that its result will not come', async () => {
    recordHandOff({ agentId: AGENT, pid: 4242, what: 'shell script "npm run build"', startedAt: Date.now() });
    expect(await tellAgentsOfCommandsCutByRestart()).toBe(1);
    const told = (db().prepare("SELECT content FROM messages WHERE agent_id = ? AND content LIKE '%Dojo restart%'").all(AGENT) as Array<{ content: string }>)
      .map((r) => r.content).join('\n');
    expect(told).toContain('npm run build');
    expect(told).toMatch(/was ended by a Dojo restart before it finished\. Its result will not come/);
    expect(await tellAgentsOfCommandsCutByRestart()).toBe(0);
  });
});
