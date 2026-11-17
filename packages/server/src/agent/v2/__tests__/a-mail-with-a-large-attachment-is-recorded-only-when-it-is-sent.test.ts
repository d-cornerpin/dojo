// A mail whose attachment is too large to go inline is uploaded to Drive first, then sent. When the upload works
// and the send fails, the mail is recorded as failed and the request it answered is not closed. Driven through
// executeTool, with Google's API faked at fetch.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../../google/auth.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getValidAccessTokenForAccount: async () => 'token' }));
vi.mock('../../../google/accounts.js', async (orig) => {
  const account = { id: 'agent', kind: 'agent', position: 1, email: 'agent@example.com', enabled: true, connected: true, sendEmail: true, enabledServices: null };
  return { ...(await orig<Record<string, unknown>>()), resolveGoogleAccountForTool: () => ({ account }), getGoogleAccount: () => account, listGoogleAccounts: () => [account] };
});

import { executeTool } from '../../tools/index.js';
import { runMigrations } from '../../../db/migrations.js';
import { homeDir } from '../../../home.js';
import { openTurnContext, endTurnContext } from '../../turn-context.js';
import { openAsk, claimAsk, stampClaimingTurn } from '../../../work/store.js';
import { freshReplyDb, testDb, AGENT } from './helpers/reply-sender.js';

const MAIL = 'person@example.com';
const BIG = path.join(homeDir(), 'site-survey.pdf');
const ORIGINAL_FETCH = globalThis.fetch;
afterAll(() => { globalThis.fetch = ORIGINAL_FETCH; fs.rmSync(BIG, { force: true }); });

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  freshReplyDb(runMigrations);
  fs.writeFileSync(BIG, '');
  fs.truncateSync(BIG, 26 * 1024 * 1024);
  // Drive takes the file (its folders exist); Gmail then refuses the send.
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes('/messages/send')) return json(500, { error: { message: 'backend error' } });
    if (u.includes('/upload/')) return json(200, { id: 'file-1', name: 'site-survey.pdf', webViewLink: 'https://drive.example.com/file-1' });
    if (u.includes('/files?q=')) return json(200, { files: [{ id: 'folder-1' }] });
    return json(200, { id: 'perm-1' });
  }) as typeof fetch;
});

describe('a mail with a large attachment is recorded only when it is sent', () => {
  it('the upload went and the send failed: one failed row, and the request stays open to answer', async () => {
    testDb().prepare("INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES ('conv-mail', ?, 'email', ?)").run(AGENT, MAIL);
    const ask = openAsk({ agentId: AGENT, messageId: 'm-mail', conversationId: 'conv-mail', requesterId: null, openedAt: Date.now() - 5_000, title: null });
    claimAsk(ask, AGENT);
    stampClaimingTurn(ask, 7);
    endTurnContext(AGENT);
    const turn = openTurnContext(AGENT);
    turn.turnNumber = 7;
    turn.root = { kind: 'ask', id: 'm-mail', sourceMessageId: 'm-mail', conversationId: 'conv-mail' };

    const out = await executeTool(AGENT, { id: 'call-mail', name: 'gmail_send', arguments: { to: MAIL, subject: 'The survey', body: 'Attached.', attachments: [BIG] } });
    expect(JSON.stringify(out)).toContain('backend error');
    const rows = testDb().prepare('SELECT outcome FROM deliveries').all() as Array<{ outcome: string }>;
    expect(rows).toEqual([{ outcome: 'failed' }]);
    expect((testDb().prepare('SELECT state FROM work WHERE id = ?').get(ask) as { state: string }).state).toBe('claimed');
  });
});
