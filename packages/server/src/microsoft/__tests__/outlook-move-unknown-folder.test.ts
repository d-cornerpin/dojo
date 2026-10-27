// ════════════════════════════════════════════════════════════════════════════════════════
// E20 (v3.5) — AN UNKNOWN FOLDER IS A THIRD ANSWER, NOT "NO".
//
// THE DEFECT. `isPutAwayFolder` answered yes/no. When Graph would not say the id of a
// well-known folder (a timeout, a throttle), a raw folder id from outlook_list_folders fell to
// "no" — indistinguishable from a real "no". The `conversation_id` road then moved EVERY
// message of the conversation (including the owner's sent copies and drafts); the
// `message_id` road silently turned "archive the whole conversation" into "move just one
// message". The fix makes "could not tell" a third answer that moves nothing and says so.
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
import { executeMicrosoftWriteTool } from '../tools-write.js';

const ok = (data: unknown) => ({ ok: true, data, error: undefined, apiEndpoint: 'x' });
const fail = (error: string) => ({ ok: false, data: null, error, apiEndpoint: 'x' });
const run = (args: Record<string, unknown>) => executeMicrosoftWriteTool('outlook_move_to_folder', args, 'agent-1', 'A Worker');

const ids = (n: number, prefix = 'c') => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}` }));
const readUrls = () => vi.mocked(msGraphRead).mock.calls.map((c) => String(c[0]));
const writes = () => vi.mocked(msGraphWrite).mock.calls;
const batches = () => writes().filter((c) => String(c[1]) === '$batch');
const batchRequests = (call: unknown[]) => (call[2] as { requests: Array<{ id: string; method: string; url: string; body: { destinationId: string } }> }).requests;

/** The mailbox: message m1 sits in conversation conv1, which has `size` messages. */
function mailbox(opts: { size?: number; listError?: string; archiveId?: string; failIds?: string[]; elsewhere?: Array<{ id: string; parentFolderId: string }>; failLookup?: 'archive' | 'deleteditems' } = {}) {
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
    if (endpoint.startsWith('me/mailFolders/archive')) return opts.failLookup === 'archive' ? fail('Graph timeout') : ok({ id: opts.archiveId ?? 'AAMk-archive-id' });
    if (endpoint.startsWith('me/mailFolders/deleteditems')) return opts.failLookup === 'deleteditems' ? fail('Graph timeout') : ok({ id: 'AAMk-deleted-id' });
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

describe('E20: an unknown folder is a third answer, not "no"', () => {
  const sentAndDraft = [{ id: 'sent1', parentFolderId: 'sent-id' }, { id: 'draft1', parentFolderId: 'drafts-id' }];
  const unknown = 'AAMk-some-project-folder';

  it('conversation_id + a raw id neither well-known folder, when Graph would not say the archive id: nothing is moved and it says so', async () => {
    mailbox({ failLookup: 'archive' });
    const out = await run({ conversation_id: 'conv1', folder_id: unknown });
    expect(out).toMatch(/^Error: could not tell whether that folder/);
    expect(writes()).toHaveLength(0);
  });

  it('the same for message_id: a failed lookup is not a silent one-message move', async () => {
    mailbox({ failLookup: 'archive' });
    const out = await run({ message_id: 'm1', folder_id: unknown });
    expect(out).toMatch(/^Error: could not tell whether that folder/);
    expect(writes()).toHaveLength(0);
  });

  it('a failed lookup does not matter when the other lookup already matches the id: the put-away move goes ahead', async () => {
    mailbox({ size: 3, elsewhere: sentAndDraft, failLookup: 'archive' });
    const out = await run({ conversation_id: 'conv1', folder_id: 'AAMk-deleted-id' });
    const moved = batchRequests(batches()[0]).map((r) => r.url);
    expect(moved).toEqual(['/me/messages/c1/move', '/me/messages/c2/move', '/me/messages/c3/move']);
    expect(out).toMatch(/2 .*other folders.*left/i);
  });

  it('both lookups ok and the folder is neither: message_id is one message, as before', async () => {
    mailbox();
    const out = await run({ message_id: 'm1', folder_id: unknown });
    expect(batches()).toHaveLength(0);
    expect(String(writes()[0][1])).toBe('me/messages/m1/move');
    expect(out).toMatch(/Email moved to folder AAMk-some-project-folder/);
  });

  it('the name shortcut still works with failing lookups configured and looks nothing up for the name', async () => {
    mailbox({ failLookup: 'archive' });
    const out = await run({ message_id: 'm1', folder_id: 'archive' });
    expect(out).toMatch(/WHOLE conversation \(7 messages\)/);
    expect(batches()).toHaveLength(1);
    expect(readUrls().some((u) => u.includes('me/mailFolders/archive'))).toBe(false);
  });
});
