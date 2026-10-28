// Gmail delivers a message as a tree of MIME parts: the body is nested under attachments
// and inline images, and many mails carry only text/html. It must be found in the tree.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const googleRead = vi.fn();
vi.mock('../client.js', () => ({ googleRead: (...a: unknown[]) => googleRead(...a) }));
vi.mock('../accounts.js', () => ({
  resolveGoogleAccountForRead: () => ({ account: { id: 'acct-1', email: 'agent@example.invalid' }, labelAccount: false }),
}));
vi.mock('../../tools/unified-read.js', () => ({ otherMailboxesCountSection: async () => '' }));

const { executeGoogleReadTool } = await import('../tools-read.js');
const { extractGmailBodyText } = await import('../gmail-body.js');

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64url');

const alternativeTree = {
  mimeType: 'multipart/alternative',
  parts: [
    { mimeType: 'text/plain', body: { data: b64('plain body') } },
    { mimeType: 'text/html', body: { data: b64('<p>html body</p>') } },
  ],
};
const mixedWithPdf = {
  mimeType: 'multipart/mixed',
  parts: [
    alternativeTree,
    { mimeType: 'application/pdf', filename: 'a.pdf', body: { attachmentId: 'att1' } },
  ],
};
const htmlOnlyTree = {
  mimeType: 'multipart/alternative',
  parts: [{ mimeType: 'text/html', body: { data: b64('<p>Hi <b>there</b></p>') } }],
};

beforeEach(() => googleRead.mockReset());

describe('extractGmailBodyText', () => {
  it('a plain single-part message is its own body', () => {
    expect(extractGmailBodyText({ mimeType: 'text/plain', body: { data: b64('hello') } })).toBe('hello');
  });

  it('multipart/alternative prefers the text/plain part', () => {
    expect(extractGmailBodyText(alternativeTree)).toBe('plain body');
  });

  it('the body nested under an attachment is still found', () => {
    expect(extractGmailBodyText(mixedWithPdf)).toBe('plain body');
  });

  it('an html-only message gives its tag-stripped text', () => {
    expect(extractGmailBodyText(htmlOnlyTree)).toBe('Hi there');
  });

  it('a text/plain attachment is not the body', () => {
    const tree = {
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/html', body: { data: b64('<p>real body</p>') } },
        { mimeType: 'text/plain', filename: 'notes.txt', body: { data: b64('ATTACHED') } },
      ],
    };
    expect(extractGmailBodyText(tree)).toBe('real body');
  });

  it('a body three levels deep is found; nothing at all gives an empty string', () => {
    const deep = {
      mimeType: 'multipart/mixed',
      parts: [{
        mimeType: 'multipart/related',
        parts: [{
          mimeType: 'multipart/alternative',
          parts: [{ mimeType: 'text/plain', body: { data: b64('deep') } }],
        }],
      }],
    };
    expect(extractGmailBodyText(deep)).toBe('deep');
    expect(extractGmailBodyText(undefined)).toBe('');
    expect(extractGmailBodyText({})).toBe('');
  });
});

describe('gmail_read finds the body in the part tree', () => {
  const readWith = (payloadTree: Record<string, unknown>) => {
    googleRead.mockResolvedValue({
      ok: true,
      data: {
        id: 'm1',
        snippet: 'SNIPPET ONLY',
        payload: { headers: [{ name: 'Subject', value: 'S' }], ...payloadTree },
      },
    });
    return executeGoogleReadTool('gmail_read', { message_id: 'm1' }, 'agent-1', 'Agent');
  };

  it('the body under an attachment beats the snippet', async () => {
    const out = await readWith(mixedWithPdf);
    expect(out).toContain('plain body');
    expect(out).not.toContain('SNIPPET ONLY');
  });

  it('an html-only message shows its text', async () => {
    const out = await readWith(htmlOnlyTree);
    expect(out).toContain('Hi there');
  });
});
