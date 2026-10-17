// ════════════════════════════════════════════════════════════════════════════════════════
// t190 C2 — ARCHIVING ACTS ON THE WHOLE CONVERSATION.
//
// THE DEFECT. `gmail_label` changed ONE message. Gmail's inbox is per-conversation: a thread
// stays in the inbox while ANY message in it carries INBOX, so removing INBOX from one message
// ("archive") left the conversation where it was and the junk came back. No thread-level call
// existed, though the `gmail.modify` scope already allows `threads/<id>/modify`.
//
// THE RULING (owner). Archive means the whole conversation, by default. The tool text says so
// plainly, and an explicit opt-out keeps the old one-message behaviour.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../client.js', () => ({ googleRead: vi.fn(), googleWrite: vi.fn() }));
vi.mock('../accounts.js', () => ({
  resolveGoogleAccountForTool: vi.fn(() => ({
    account: {
      id: 'agent', kind: 'agent', position: 1, email: 'agent@example.com',
      enabled: true, connected: true, accessToken: null, refreshToken: null,
      tokenExpiresAt: null, grantedScopes: null, enabledServices: null,
      watchEmail: false, sendEmail: true, lastVerifiedAt: null,
    },
  })),
}));

import { googleRead, googleWrite } from '../client.js';
import { executeGoogleWriteTool, googleWriteToolDefinitions } from '../tools-write.js';

const ok = (data: unknown) => ({ ok: true, data, error: undefined, apiEndpoint: 'x' });
const run = (name: string, args: Record<string, unknown>) =>
  executeGoogleWriteTool(name, args, 'agent-1', 'A Worker');
const writtenUrl = (): string => String(vi.mocked(googleWrite).mock.calls[0]?.[1]);
const writtenBody = (): Record<string, unknown> =>
  vi.mocked(googleWrite).mock.calls[0]?.[2] as Record<string, unknown>;

beforeEach(() => {
  vi.mocked(googleRead).mockReset();
  vi.mocked(googleWrite).mockReset();
  vi.mocked(googleRead).mockResolvedValue(ok({ id: 'm1', threadId: 'thr9' }) as never);
  vi.mocked(googleWrite).mockResolvedValue(ok({ id: 'thr9', messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] }) as never);
});

describe('t190 C2 — gmail_label archive is conversation-wide by default', () => {
  it('removing INBOX from a message archives its WHOLE thread via threads/<id>/modify', async () => {
    const out = await run('gmail_label', { message_id: 'm1', remove_labels: ['INBOX'] });
    expect(writtenUrl()).toMatch(/\/threads\/thr9\/modify$/);
    expect(writtenBody().removeLabelIds).toEqual(['INBOX']);
    expect(out).toMatch(/conversation/i);
    expect(out).not.toMatch(/^Error/);
  });

  it('the thread id is looked up from the message, and a failed lookup is an error, never a silent one-message fallback', async () => {
    vi.mocked(googleRead).mockResolvedValue({ ok: false, data: null, error: 'Requested entity was not found.', apiEndpoint: 'x' } as never);
    const out = await run('gmail_label', { message_id: 'gone', remove_labels: ['INBOX'] });
    expect(out).toMatch(/^Error/);
    expect(googleWrite).not.toHaveBeenCalled();
  });

  it('the INBOX match is case-insensitive', async () => {
    await run('gmail_label', { message_id: 'm1', remove_labels: ['inbox'] });
    expect(writtenUrl()).toMatch(/\/threads\/thr9\/modify$/);
  });

  it('this_message_only keeps the one-message behaviour', async () => {
    await run('gmail_label', { message_id: 'm1', remove_labels: ['INBOX'], this_message_only: true });
    expect(writtenUrl()).toMatch(/\/messages\/m1\/modify$/);
    expect(googleRead).not.toHaveBeenCalled();
  });

  it('thread_id acts on that conversation directly, with no lookup', async () => {
    await run('gmail_label', { thread_id: 'thr9', add_labels: ['STARRED'] });
    expect(writtenUrl()).toMatch(/\/threads\/thr9\/modify$/);
    expect(writtenBody().addLabelIds).toEqual(['STARRED']);
    expect(googleRead).not.toHaveBeenCalled();
  });

  it('a label change that is not an archive stays on the one message', async () => {
    await run('gmail_label', { message_id: 'm1', add_labels: ['STARRED'] });
    expect(writtenUrl()).toMatch(/\/messages\/m1\/modify$/);
  });

  it('the user_ twin behaves the same', async () => {
    await run('user_gmail_label', { message_id: 'm1', remove_labels: ['INBOX'] });
    expect(writtenUrl()).toMatch(/\/threads\/thr9\/modify$/);
  });

  it('needs exactly one of message_id / thread_id', async () => {
    expect(await run('gmail_label', { remove_labels: ['INBOX'] })).toMatch(/^Error/);
    expect(await run('gmail_label', { message_id: 'm1', thread_id: 't', remove_labels: ['INBOX'] })).toMatch(/^Error/);
    expect(googleWrite).not.toHaveBeenCalled();
  });

  it('the tool text says plainly what archiving does', () => {
    const def = googleWriteToolDefinitions.find((d) => d.name === 'gmail_label')!;
    expect(def.description).toMatch(/WHOLE conversation/);
    expect(def.description).toMatch(/this_message_only/);
    const props = (def.input_schema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['thread_id', 'this_message_only']));
    expect((def.input_schema as { required?: string[] }).required ?? []).not.toContain('message_id');
  });
});
