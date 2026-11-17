// The agent's own send tool (an iMessage, a mail) is recorded once, when the send ends, with what happened. A
// send that went closes the request it answers; one that failed leaves it open to be answered. Driven through
// executeTool, with a stand-in `imsg` where the bridge looks for one and Google's API faked at fetch.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../../services/imessage-bridge.js', async (orig) => {
  const real = await orig<typeof import('../../../services/imessage-bridge.js')>();
  return { ...real, getIMBridgeStatus: () => ({ ...real.getIMBridgeStatus(), running: true, enabled: true, connected: true }) };
});
vi.mock('../../../google/auth.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getValidAccessTokenForAccount: async () => 'token' }));
vi.mock('../../../google/accounts.js', async (orig) => {
  const account = { id: 'agent', kind: 'agent', position: 1, email: 'agent@example.com', enabled: true, connected: true, sendEmail: true, enabledServices: null };
  return { ...(await orig<Record<string, unknown>>()), resolveGoogleAccountForTool: () => ({ account }), getGoogleAccount: () => account, listGoogleAccounts: () => [account] };
});

// The iMessage tool first: it must bind to the faked bridge status before the bridge's own imports reach it.
import '../../tools/cat/comms.js';
import { executeTool } from '../../tools/index.js';
import { runMigrations } from '../../../db/migrations.js';
import { homeDir } from '../../../home.js';
import { openTurnContext, endTurnContext } from '../../turn-context.js';
import { openAsk, claimAsk, stampClaimingTurn } from '../../../work/store.js';
import { freshReplyDb, setApproved, testDb, AGENT, PERSON } from './helpers/reply-sender.js';

const MAIL = 'person@example.com';
const IMSG = path.join(homeDir(), '.dojo', 'bin', 'imsg');
const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_FETCH = globalThis.fetch;

beforeAll(() => {
  // The stand-in: `--help` is the bridge's probe; a send exits with $IMSG_EXIT. Its osascript fallback fails too.
  fs.mkdirSync(path.dirname(IMSG), { recursive: true });
  fs.writeFileSync(IMSG, '#!/bin/sh\n[ "$1" = "--help" ] && exit 0\nexit "${IMSG_EXIT:-0}"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(path.dirname(IMSG), 'osascript'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  process.env.PATH = `${path.dirname(IMSG)}:${ORIGINAL_PATH}`;
});
afterAll(() => { process.env.PATH = ORIGINAL_PATH; globalThis.fetch = ORIGINAL_FETCH; });

const rows = (): Array<{ id: string; tool: string; channel: string; outcome: string }> =>
  testDb().prepare('SELECT id, tool, channel, outcome FROM deliveries ORDER BY rowid').all() as never;
const ask = (id: string): { state: string; result_delivery_id: string | null } =>
  testDb().prepare('SELECT state, result_delivery_id FROM work WHERE id = ?').get(id) as never;

/** A request from `who` on `channel`, picked up by turn 7, which is the live turn. */
function requestOn(channel: 'imessage' | 'email', who: string): string {
  const conv = `conv-${channel}`;
  testDb().prepare('INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, ?, ?)').run(conv, AGENT, channel, who);
  const id = openAsk({ agentId: AGENT, messageId: `m-${channel}`, conversationId: conv, requesterId: null, openedAt: Date.now() - 5_000, title: null });
  claimAsk(id, AGENT);
  stampClaimingTurn(id, 7);
  endTurnContext(AGENT);
  const turn = openTurnContext(AGENT);
  turn.turnNumber = 7;
  turn.root = { kind: 'ask', id: `m-${channel}`, sourceMessageId: `m-${channel}`, conversationId: conv };
  return id;
}

/** Google's API: every call answers ok except the mail send, which answers `sendStatus`; `during` is the ledger then. */
function fakeGoogle(sendStatus: number, onSend: () => void = () => {}): { during: number[] } {
  const seen = { during: [] as number[] };
  globalThis.fetch = (async (url: string | URL) => {
    if (String(url).includes('/messages/send')) {
      seen.during.push(rows().length);
      onSend();
      return new Response(JSON.stringify(sendStatus === 200 ? { id: 'sent-1', threadId: 't-1' } : { error: { message: 'backend error' } }), { status: sendStatus, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ id: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return seen;
}

const send = (name: string, args: Record<string, unknown>) => executeTool(AGENT, { id: `call-${name}`, name, arguments: args });

beforeEach(() => {
  freshReplyDb(runMigrations);
  setApproved([PERSON]);
  delete process.env.IMSG_EXIT;
});

describe('a tool send writes one row when it ends', () => {
  it('a mail that goes: nothing is written while it is on the wire, then one delivered row closes the request', async () => {
    const id = requestOn('email', MAIL);
    const google = fakeGoogle(200);
    await send('gmail_send', { to: MAIL, subject: 'The quote', body: 'The roof quote is fine.' });
    expect(google.during, 'no row stands for a send that has not ended').toEqual([0]);
    expect(rows()).toMatchObject([{ tool: 'gmail_send', channel: 'email', outcome: 'delivered' }]);
    expect(ask(id)).toEqual({ state: 'done', result_delivery_id: rows()[0].id });
  });

  it('a mail that fails: one failed row, and the request is still the agent\'s to answer', async () => {
    const id = requestOn('email', MAIL);
    fakeGoogle(500);
    await send('gmail_send', { to: MAIL, subject: 'The quote', body: 'The roof quote is fine.' });
    expect(rows()).toMatchObject([{ tool: 'gmail_send', outcome: 'failed' }]);
    expect(ask(id).state).toBe('claimed');
  });

  it('a mail that ends after a later turn opened is recorded under the turn it began in', async () => {
    const id = requestOn('email', MAIL);
    fakeGoogle(200, () => { endTurnContext(AGENT); openTurnContext(AGENT).turnNumber = 8; });
    await send('gmail_send', { to: MAIL, subject: 'The quote', body: 'The roof quote is fine.' });
    expect(testDb().prepare('SELECT turn_number FROM deliveries').all()).toEqual([{ turn_number: 7 }]);
    expect(ask(id).state).toBe('done');
  });

  it('an iMessage that goes: one delivered row closes the request', async () => {
    const id = requestOn('imessage', PERSON);
    await send('imessage_send', { recipient: PERSON, message: 'The roof quote is fine.' });
    expect(rows()).toMatchObject([{ tool: 'imessage_send', channel: 'imessage', outcome: 'delivered' }]);
    expect(ask(id)).toEqual({ state: 'done', result_delivery_id: rows()[0].id });
  });

  it('an iMessage that fails on every path: one failed row, and the request stays open to answer', async () => {
    const id = requestOn('imessage', PERSON);
    process.env.IMSG_EXIT = '1';
    await send('imessage_send', { recipient: PERSON, message: 'The roof quote is fine.' });
    expect(rows()).toMatchObject([{ tool: 'imessage_send', outcome: 'failed' }]);
    expect(ask(id).state).toBe('claimed');
  });
});
