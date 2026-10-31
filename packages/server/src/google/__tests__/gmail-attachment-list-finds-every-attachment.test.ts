// An attached text/HTML file, and any attachment inside a nested part, must be listed.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const googleRead = vi.fn();
vi.mock('../client.js', () => ({ googleRead: (...a: unknown[]) => googleRead(...a) }));
vi.mock('../accounts.js', () => ({
  resolveGoogleAccountForRead: () => ({ account: { id: 'acct-1', email: 'agent@example.invalid' }, labelAccount: false }),
}));
vi.mock('../../tools/unified-read.js', () => ({ otherMailboxesCountSection: async () => '' }));

const { executeGoogleReadTool } = await import('../tools-read.js');

const b64 = (s: string) => Buffer.from(s).toString('base64url');
const payload = {
  mimeType: 'multipart/mixed',
  headers: [{ name: 'From', value: 'a@example.invalid' }, { name: 'Subject', value: 'files' }, { name: 'Date', value: 'Wed, 20 May 2026 19:00:00 +0000' }],
  parts: [
    {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64('plain body text'), size: 15 } },
        { mimeType: 'text/html', body: { data: b64('<p>html body text</p>'), size: 21 } },
      ],
    },
    { mimeType: 'text/plain', filename: 'notes.txt', body: { attachmentId: 'A1', size: 2048 } },
    { mimeType: 'multipart/related', parts: [{ mimeType: 'application/pdf', filename: 'deep.pdf', body: { attachmentId: 'A2', size: 4096 } }] },
  ],
};

beforeEach(() => {
  googleRead.mockReset();
  googleRead.mockImplementation(async () => ({ ok: true, data: { id: 'm1', snippet: 'snip', payload } }));
});

describe('attachments are found at every depth and of every type', () => {
  for (const tool of ['gmail_read', 'gmail_list_attachments']) {
    it(`${tool} lists notes.txt and deep.pdf, not the body parts`, async () => {
      const out = await executeGoogleReadTool(tool, { message_id: 'm1' }, 'agent-1', 'A Worker');
      expect(out).toContain('notes.txt');
      expect(out).toContain('attachment_id: A1');
      expect(out).toContain('deep.pdf');
      expect(out).toContain('attachment_id: A2');
      expect(out).toContain('Attachments (2)');
    });
  }
});
