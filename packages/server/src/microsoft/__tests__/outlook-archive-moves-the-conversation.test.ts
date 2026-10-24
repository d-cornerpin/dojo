// ════════════════════════════════════════════════════════════════════════════════════════
// E20 (v3.5) — OUTLOOK ARCHIVES WHOLE CONVERSATIONS, AS GMAIL DOES.
//
// THE DEFECT. `outlook_move_to_folder` moved ONE message. A mail thread is a conversation to the
// owner: archiving a reply left the rest of the thread in the inbox and the thread came back.
// Gmail (t190 C2) already archives the whole conversation by default, with `this_message_only` as
// the opt-out and `thread_id` as the direct address. Outlook has the same idea under a different
// name: every message carries a `conversationId`, which the reads never asked for.
//
// THE RULE. A move to the well-known `archive` or `deleteditems` folder acts on the message's whole
// conversation unless `this_message_only` is set; a move anywhere else is one message unless
// `conversation_id` is given. The conversation is listed first (paging to its end), then moved through
// Graph `$batch` in groups of 20 (Graph's documented batch size). A failure to list moves nothing.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../client.js', () => ({
  msGraphRead: vi.fn(), msGraphWrite: vi.fn(), graphFetch: vi.fn(),
  calendarPrefix: () => 'me/', drivePrefix: () => 'me/drive/',
}));
vi.mock('../accounts.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../accounts.js');
  const account = { id: 'agent', kind: 'agent', position: 1, email: 'agent@example.com', connected: true, sendEmail: true };
  return {
    ...actual,
    resolveMicrosoftAccountForTool: vi.fn(() => ({ account })),
    resolveMicrosoftAccountForRead: vi.fn(() => ({ account, labelAccount: false })),
  };
});
vi.mock('../../tools/unified-read.js', () => ({ otherMailboxesCountSection: vi.fn(async () => '') }));

import { msGraphRead, msGraphWrite } from '../client.js';
import { executeMicrosoftWriteTool, microsoftWriteToolDefinitions } from '../tools-write.js';
import { executeMicrosoftReadTool } from '../tools-read.js';

const ok = (data: unknown) => ({ ok: true, data, error: undefined, apiEndpoint: 'x' });
const fail = (error: string) => ({ ok: false, data: null, error, apiEndpoint: 'x' });
const run = (args: Record<string, unknown>) => executeMicrosoftWriteTool('outlook_move_to_folder', args, 'agent-1', 'A Worker');

const ids = (n: number, prefix = 'c') => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}` }));
const readUrls = () => vi.mocked(msGraphRead).mock.calls.map((c) => String(c[0]));
const writes = () => vi.mocked(msGraphWrite).mock.calls;
const batches = () => writes().filter((c) => String(c[1]) === '$batch');
const batchRequests = (call: unknown[]) => (call[2] as { requests: Array<{ id: string; method: string; url: string; body: { destinationId: string } }> }).requests;

/** The mailbox: message m1 sits in conversation conv1, which has `size` messages. */
function mailbox(opts: { size?: number; listError?: string; archiveId?: string; failIds?: string[]; elsewhere?: Array<{ id: string; parentFolderId: string }> } = {}) {
  const size = opts.size ?? 7;
  vi.mocked(msGraphRead).mockImplementation((async (endpoint: string) => {
    if (/^me\/messages\/[^/?]+\?\$select=conversationId,parentFolderId$/.test(endpoint)) return ok({ id: 'm1', conversationId: 'conv1', parentFolderId: 'inbox-id' });
    if (endpoint.startsWith('me/messages?') && decodeURIComponent(endpoint).includes("conversationId eq 'conv1'")) {
      if (opts.listError) return fail(opts.listError);
      // Two pages when it is long, to prove the listing follows the link to the end.
      const all = [...ids(size).map((m) => ({ ...m, parentFolderId: 'inbox-id' })), ...(opts.elsewhere ?? [])];
      if (size > 25) return ok({ value: all.slice(0, 25), '@odata.nextLink': 'https://graph.microsoft.com/v1.0/page2' });
      return ok({ value: all });
    }
    if (endpoint === 'https://graph.microsoft.com/v1.0/page2') return ok({ value: [...ids(size).map((m) => ({ ...m, parentFolderId: 'inbox-id' })), ...(opts.elsewhere ?? [])].slice(25) });
    if (endpoint.startsWith('me/mailFolders/sentitems')) return ok({ id: 'sent-id' });
    if (endpoint.startsWith('me/mailFolders/drafts')) return ok({ id: 'drafts-id' });
    if (endpoint.startsWith('me/mailFolders/archive')) return ok({ id: opts.archiveId ?? 'AAMk-archive-id' });
    if (endpoint.startsWith('me/mailFolders/deleteditems')) return ok({ id: 'AAMk-deleted-id' });
    return fail(`unexpected read ${endpoint}`);
  }) as never);
  vi.mocked(msGraphWrite).mockImplementation((async (_m: string, endpoint: string, body: unknown) => {
    if (endpoint === '$batch') {
      const reqs = (body as { requests: Array<{ id: string; url: string }> }).requests;
      return ok({
        responses: reqs.map((r) => {
          const bad = (opts.failIds ?? []).some((f) => r.url.includes(`/${f}/`));
          return bad ? { id: r.id, status: 404, body: { error: { message: 'The specified object was not found in the store.' } } }
                     : { id: r.id, status: 201, body: { id: `new-${r.id}` } };
        }),
      });
    }
    return ok({ id: 'moved-1' });
  }) as never);
}

beforeEach(() => { vi.mocked(msGraphRead).mockReset(); vi.mocked(msGraphWrite).mockReset(); });

describe('E20: outlook_move_to_folder to the archive moves the conversation', () => {
  it('archive + message_id: the conversation is listed and ALL 7 messages move in one $batch', async () => {
    mailbox({ size: 7 });
    const out = await run({ message_id: 'm1', folder_id: 'archive' });
    expect(batches()).toHaveLength(1);
    const reqs = batchRequests(batches()[0]);
    expect(reqs).toHaveLength(7);
    expect(reqs.every((r) => r.method === 'POST' && /^\/me\/messages\/c\d+\/move$/.test(r.url) && r.body.destinationId === 'archive')).toBe(true);
    expect(out).toMatch(/Moved the WHOLE conversation \(7 messages\)/);
    expect(out).not.toMatch(/^Error/);
    expect(writes().some((c) => /^me\/messages\/[^/]+\/move$/.test(String(c[1])))).toBe(false);
  });

  it('deleteditems is a whole-conversation folder too', async () => {
    mailbox({ size: 3 });
    const out = await run({ message_id: 'm1', folder_id: 'DeletedItems' });
    expect(batchRequests(batches()[0])).toHaveLength(3);
    expect(out).toMatch(/WHOLE conversation \(3 messages\)/);
  });

  it('the Archive folder named by its id (from outlook_list_folders) counts as the archive', async () => {
    mailbox({ size: 4, archiveId: 'AAMk-archive-id' });
    const out = await run({ message_id: 'm1', folder_id: 'AAMk-archive-id' });
    expect(batchRequests(batches()[0])).toHaveLength(4);
    expect(out).toMatch(/WHOLE conversation \(4 messages\)/);
  });

  const sentAndDraft = [{ id: 'sent1', parentFolderId: 'sent-id' }, { id: 'draft1', parentFolderId: 'drafts-id' }];

  it('only the messages in the SAME folder move: a sent reply and a draft stay where they are (archive)', async () => {
    mailbox({ size: 3, elsewhere: sentAndDraft });
    const out = await run({ message_id: 'm1', folder_id: 'archive' });
    const moved = batchRequests(batches()[0]).map((r) => r.url);
    expect(moved).toEqual(['/me/messages/c1/move', '/me/messages/c2/move', '/me/messages/c3/move']);
    expect(out).toMatch(/Moved the WHOLE conversation \(3 messages\)/);
    expect(out).toMatch(/2 .*other folders.*left/i);
  });

  it('the same for deleteditems: sent mail and drafts are not deleted', async () => {
    mailbox({ size: 3, elsewhere: sentAndDraft });
    await run({ message_id: 'm1', folder_id: 'deleteditems' });
    const moved = batchRequests(batches()[0]).map((r) => r.url);
    expect(moved).toHaveLength(3);
    expect(moved.some((u) => /sent1|draft1/.test(u))).toBe(false);
  });

  it('a conversation_id given by itself to the archive or deleteditems leaves Sent Items and Drafts alone', async () => {
    for (const folder of ['archive', 'deleteditems']) {
      vi.mocked(msGraphRead).mockReset(); vi.mocked(msGraphWrite).mockReset();
      mailbox({ size: 3, elsewhere: sentAndDraft });
      const out = await run({ conversation_id: 'conv1', folder_id: folder });
      const moved = batchRequests(batches()[0]).map((r) => r.url);
      expect(moved, folder).toEqual(['/me/messages/c1/move', '/me/messages/c2/move', '/me/messages/c3/move']);
      expect(out).toMatch(/2 .*other folders.*left/i);
    }
  });

  it('a conversation_id given by itself to any OTHER folder still moves every message', async () => {
    mailbox({ size: 3, elsewhere: sentAndDraft });
    await run({ conversation_id: 'conv1', folder_id: 'AAMk-project-folder' });
    expect(batchRequests(batches()[0])).toHaveLength(5);
  });

  it('if Sent Items and Drafts cannot be identified, nothing is moved and it says so', async () => {
    mailbox({ size: 3, elsewhere: sentAndDraft });
    const base = vi.mocked(msGraphRead).getMockImplementation()!;
    vi.mocked(msGraphRead).mockImplementation((async (e: string, ...rest: unknown[]) =>
      e.startsWith('me/mailFolders/sentitems') ? fail('throttled') : (base as (...a: unknown[]) => unknown)(e, ...rest)) as never);
    const out = await run({ conversation_id: 'conv1', folder_id: 'archive' });
    expect(out).toMatch(/^Error.*nothing was moved/i);
    expect(writes()).toHaveLength(0);
  });

  it('this_message_only moves the one message and looks nothing up', async () => {
    mailbox();
    await run({ message_id: 'm1', folder_id: 'archive', this_message_only: true });
    expect(batches()).toHaveLength(0);
    expect(String(writes()[0][1])).toBe('me/messages/m1/move');
    expect(readUrls().some((u) => u.includes('conversationId'))).toBe(false);
  });

  it('a project folder is one message, as before', async () => {
    mailbox();
    const out = await run({ message_id: 'm1', folder_id: 'AAMk-project-folder' });
    expect(batches()).toHaveLength(0);
    expect(String(writes()[0][1])).toBe('me/messages/m1/move');
    expect(out).toMatch(/Email moved to folder AAMk-project-folder/);
  });

  it('conversation_id given: every message of it moves, whatever the folder, with no message lookup', async () => {
    mailbox({ size: 5 });
    const out = await run({ conversation_id: 'conv1', folder_id: 'AAMk-project-folder' });
    expect(batchRequests(batches()[0])).toHaveLength(5);
    expect(readUrls().some((u) => /^me\/messages\/[^/?]+\?/.test(u))).toBe(false);
    expect(out).toMatch(/WHOLE conversation \(5 messages\)/);
  });

  it('a long conversation is listed to its end and moved in groups of 20', async () => {
    mailbox({ size: 45 });
    const out = await run({ message_id: 'm1', folder_id: 'archive' });
    expect(batches().map((c) => batchRequests(c).length)).toEqual([20, 20, 5]);
    expect(out).toMatch(/\(45 messages\)/);
  });

  it('a listing failure moves nothing and says so', async () => {
    mailbox({ listError: 'The request timed out.' });
    const out = await run({ message_id: 'm1', folder_id: 'archive' });
    expect(out).toMatch(/^Error/);
    expect(out).toMatch(/nothing was moved/i);
    expect(out).toMatch(/this_message_only/);
    expect(writes()).toHaveLength(0);
  });

  it('a message that could not be moved is reported, not counted as moved', async () => {
    mailbox({ size: 7, failIds: ['c3'] });
    const out = await run({ message_id: 'm1', folder_id: 'archive' });
    expect(out).toMatch(/Moved 6 of 7 messages/);
    expect(out).toMatch(/not found in the store/);
  });

  it('the call needs a message_id or a conversation_id, and not both', async () => {
    mailbox();
    expect(await run({ folder_id: 'archive' })).toMatch(/^Error.*message_id.*conversation_id/);
    expect(await run({ message_id: 'm1', conversation_id: 'conv1', folder_id: 'archive' })).toMatch(/^Error.*not both/);
    expect(writes()).toHaveLength(0);
  });

  it('the schema offers conversation_id and this_message_only and only folder_id is required', () => {
    const def = microsoftWriteToolDefinitions.find((t) => t.name === 'outlook_move_to_folder')!;
    const props = (def.input_schema as { properties: Record<string, unknown>; required: string[] });
    expect(Object.keys(props.properties)).toEqual(expect.arrayContaining(['message_id', 'folder_id', 'conversation_id', 'this_message_only']));
    expect(props.required).toEqual(['folder_id']);
  });
});

describe('E20: the reads carry the conversation id', () => {
  const msg = {
    id: 'm1', subject: 'Quarterly numbers', receivedDateTime: '2026-10-20T10:00:00Z', bodyPreview: 'hello', isRead: true, hasAttachments: false,
    from: { emailAddress: { name: 'A Sender', address: 'sender@example.com' } },
    toRecipients: [{ emailAddress: { name: 'Me', address: 'me@example.com' } }],
    body: { contentType: 'text', content: 'hello' }, conversationId: 'conv-AAQk',
  };
  const read = (name: string, args: Record<string, unknown>) => executeMicrosoftReadTool(name, args, 'agent-1', 'A Worker');

  it('outlook_search prints a Conversation: line and asks Graph for the field', async () => {
    vi.mocked(msGraphRead).mockResolvedValue(ok({ value: [msg] }) as never);
    const out = await read('outlook_search', { query: 'numbers' });
    expect(String(vi.mocked(msGraphRead).mock.calls[0][0])).toContain('conversationId');
    expect(out).toMatch(/Conversation: conv-AAQk/);
  });

  it('outlook_search verbose prints it too', async () => {
    vi.mocked(msGraphRead).mockResolvedValue(ok({ value: [msg] }) as never);
    expect(await read('outlook_search', { query: 'numbers', verbose: true })).toMatch(/Conversation: conv-AAQk/);
  });

  it('outlook_read prints it', async () => {
    vi.mocked(msGraphRead).mockResolvedValue(ok(msg) as never);
    const out = await read('outlook_read', { message_id: 'm1' });
    expect(String(vi.mocked(msGraphRead).mock.calls[0][0])).toContain('conversationId');
    expect(out).toMatch(/Conversation: conv-AAQk/);
  });

  it('outlook_inbox prints it', async () => {
    vi.mocked(msGraphRead).mockResolvedValue(ok({ value: [msg] }) as never);
    const out = await read('outlook_inbox', {});
    expect(String(vi.mocked(msGraphRead).mock.calls[0][0])).toContain('conversationId');
    expect(out).toMatch(/Conversation: conv-AAQk/);
  });
});
