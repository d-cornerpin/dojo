// "The owner asked for this" is proven only by a whole sentence the owner himself wrote in the message this
// turn answers (or since): a fragment, an approved contact's words and the engine's envelope text never pass.
// Driven through the tool executor and the real message ingest, in a scratch home: the owner-hold release
// and the reassign cause="user_requested" door share the one check.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const MAIN = 'agent-main';
const PEER = 'agent-peer';
const OWNER_WORDS = 'Go ahead and pick the invoice task back up now.';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'owner-sentence-'));
vi.stubEnv('DOJO_HOME', home);
const connection = await import('../../db/connection.js');
const migrations = await import('../../db/migrations.js');
const platform = await import('../../config/platform.js');
const { executeTool, toolResultOf } = await import('../../agent/tools/index.js');
const { insertMessage } = await import('../../memory/message-store.js');
const { setHold, holdOf } = await import('../done/hold.js');
const { openTurnContext, endTurnContext } = await import('../../agent/turn-context.js');

let n = 0;
beforeAll(() => {
  migrations.runMigrations();
  const db = connection.getDb();
  const add = db.prepare("INSERT INTO agents (id, name, status, config, classification) VALUES (?, ?, ?, '{}', ?)");
  add.run(MAIN, 'main', 'idle', 'sensei');
  add.run(PEER, 'peer', 'working', 'apprentice');
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(MAIN);
  platform.clearPlatformConfigCache();
});
afterEach(() => endTurnContext(MAIN));
afterAll(() => {
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

function task(holder: string): string {
  const id = `task-${++n}-0000-0000`;
  connection.getDb().prepare(
    `INSERT INTO work (id, kind, agent_id, assignee_agent, requester, requester_id, root_kind, root_id, state, intent,
                       wakes, closes_thread, title, opened_at, updated_at)
     VALUES (?, 'task', ?, ?, 'agent', ?, 'tracker', ?, 'claimed', 'tracker', 0, 0, 'Reconcile the invoices', ?, ?)`,
  ).run(id, holder, holder, MAIN, id, Date.now(), Date.now());
  return id;
}

function ownerHeld(): string {
  const id = task(MAIN);
  expect(setHold(id, 'paused', 'the owner wants to look first', 'owner')).toEqual({ ok: true });
  return id;
}

/** The main agent's turn answers this inbound row, stored through the real ingest. */
function turnOn(row: { channel: string; content: string; inboundMeta: Record<string, unknown> }): void {
  const id = `msg-${++n}`;
  insertMessage({
    id, agentId: MAIN, role: 'user', conversationId: `conv-${n}`, channel: row.channel,
    authorized: true, content: row.content, inboundMeta: JSON.stringify(row.inboundMeta),
  });
  openTurnContext(MAIN).root = { kind: 'ask', id, sourceMessageId: id, conversationId: `conv-${n}` };
}

const ownerDashboard = (content: string) => turnOn({
  channel: 'dashboard', content, inboundMeta: { channel: 'dashboard', accountKind: 'agent', authorized: true, relation: 'owner' },
});
const envelope = (who: string) => `[SOURCE: IMESSAGE FROM ${who} - this person texted YOUR OWN iMessage account (the DOJO bridge). `
  + 'Reply here; no separate update or permission is needed.]';
const iMessage = (relation: 'owner' | 'known_contact', text: string) => turnOn({
  channel: 'imessage', content: `${envelope(relation === 'owner' ? 'Owner' : 'A Friend')} ${text}`,
  inboundMeta: { channel: 'imessage', accountKind: 'agent', authorized: true, sender: '+15550100', chatType: 'dm', relation },
});

const resume = async (taskId: string, quote: string) => toolResultOf(await executeTool(MAIN, {
  id: `call-${++n}`, name: 'work_update', arguments: { action: 'status', task_id: taskId, status: 'in_progress', user_quote: quote },
})).content;

const reassign = async (taskId: string, quote: string) => toolResultOf(await executeTool(MAIN, {
  id: `call-${++n}`, name: 'work_update',
  arguments: { action: 'reassign', task_id: taskId, assigned_to: MAIN, cause: 'user_requested', user_quote: quote },
})).content;

describe('only the owner\'s own sentence passes as his ask', () => {
  it.each([
    ['a single letter', 'e'],
    ['a fragment of his sentence', 'pick the invoice task'],
  ])('%s is refused', async (_label, quote) => {
    const id = ownerHeld();
    ownerDashboard(OWNER_WORDS);
    expect(await resume(id, quote)).toMatch(/^Refused: /);
    expect(holdOf(id)?.kind).toBe('paused');
  });

  it('an approved contact\'s words are refused', async () => {
    const id = ownerHeld();
    const theirs = 'Please resume the invoice task today.';
    iMessage('known_contact', theirs);
    expect(await resume(id, theirs)).toMatch(/^Refused: /);
    expect(holdOf(id)?.kind).toBe('paused');
  });

  it('the engine\'s envelope text on his own text is refused', async () => {
    const id = ownerHeld();
    iMessage('owner', 'Thanks, all good here.');
    expect(await resume(id, 'Reply here; no separate update or permission is needed')).toMatch(/^Refused: /);
    expect(holdOf(id)?.kind).toBe('paused');
  });

  it('his whole sentence on the dashboard lifts the hold', async () => {
    const id = ownerHeld();
    ownerDashboard(OWNER_WORDS);
    expect(await resume(id, OWNER_WORDS)).toMatch(/^\[OK\]/);
    expect(holdOf(id)).toBeNull();
  });

  it('his whole sentence in his own text lifts the hold', async () => {
    const id = ownerHeld();
    iMessage('owner', OWNER_WORDS);
    expect(await resume(id, OWNER_WORDS)).toMatch(/^\[OK\]/);
    expect(holdOf(id)).toBeNull();
  });

  it('his whole sentence in a confirmed email lifts the hold', async () => {
    const id = ownerHeld();
    turnOn({
      channel: 'email', content: 'Subject: invoices\n\nquoted thread and headers',
      inboundMeta: { channel: 'email', accountKind: 'agent', authorized: true, relation: 'owner', ownerWords: OWNER_WORDS, ownerWordsAt: Date.now() + 1000 },
    });
    expect(await resume(id, OWNER_WORDS)).toMatch(/^\[OK\]/);
    expect(holdOf(id)).toBeNull();
  });

  it('a reassign of a live peer\'s task: a fragment is refused, his sentence is accepted', async () => {
    const id = task(PEER);
    ownerDashboard(OWNER_WORDS);
    expect(await reassign(id, 'invoice')).toMatch(/could not be confirmed/);
    expect(await reassign(id, OWNER_WORDS)).not.toMatch(/could not be confirmed/);
  });
});
