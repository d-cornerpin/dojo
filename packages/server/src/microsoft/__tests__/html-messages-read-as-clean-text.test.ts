// Outlook and Teams deliver HTML bodies. The three read paths flattened them with a bare tag regex:
// the CSS inside a <style> block came back as the first screen of the mail, `&amp;` and `&nbsp;`
// printed as typed, and every paragraph break became a space. The shared `stripHtmlTags`
// (`agent/html-text.ts`, what gmail_read and web_fetch already use) does this properly.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../client.js', () => ({
  msGraphRead: vi.fn(),
  calendarPrefix: (id?: string) => (id ? `me/calendars/${id}/` : 'me/'),
  drivePrefix: () => 'me/drive/',
  graphFetch: vi.fn(),
}));
vi.mock('../accounts.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveMicrosoftAccountForRead: vi.fn(() => ({ account: { id: 'agent', kind: 'agent', email: 'agent@example.com', connected: true }, labelAccount: false })),
}));

import { msGraphRead } from '../client.js';
import { executeMicrosoftReadTool } from '../tools-read.js';

const outlookMail = (contentType: string, content: string) => ({
  id: 'm1',
  from: { emailAddress: { name: 'A', address: 'a@example.invalid' } },
  toRecipients: [],
  subject: 's',
  receivedDateTime: '2026-03-25T10:00:00Z',
  hasAttachments: false,
  body: { contentType, content },
});

const HTML_MAIL = '<html><head><style>p.MsoNormal{margin:0in}</style></head><body><p>Tom &amp; Jerry</p><p>Second line</p></body></html>';
const CHAT_MESSAGE = {
  id: 't1',
  from: { user: { displayName: 'A' } },
  createdDateTime: '2026-03-25T10:00:00Z',
  body: { contentType: 'html', content: '<div><style>p.MsoInfobox{color:#5B5FC7}</style>Standup&nbsp;notes<br>Blocked on the API</div>' },
};
const CHANNEL_MESSAGE = {
  id: 't2',
  from: { user: { displayName: 'A' } },
  createdDateTime: '2026-03-25T10:00:00Z',
  body: { contentType: 'html', content: '<style>.hlx{font-family:Segoe}</style><div>Deploy&nbsp;done</div><div>Review tomorrow</div>' },
};

/** The body outlook_read serves; the text-passthrough case swaps it before its call. */
let outlookBody = { contentType: 'html', content: HTML_MAIL };

beforeEach(() => {
  outlookBody = { contentType: 'html', content: HTML_MAIL };
  vi.mocked(msGraphRead).mockReset();
  vi.mocked(msGraphRead).mockImplementation((async (endpoint: string) => {
    if (endpoint.startsWith('me/messages/')) return { ok: true, data: outlookMail(outlookBody.contentType, outlookBody.content), error: null };
    if (endpoint.startsWith('chats/')) return { ok: true, data: { value: [CHAT_MESSAGE] }, error: null };
    return { ok: true, data: { value: [CHANNEL_MESSAGE] }, error: null };
  }) as never);
});

describe('outlook_read — an HTML mail reads as the sender wrote it', () => {
  it('decodes entities, keeps the paragraph break, and drops the style block', async () => {
    const out = await executeMicrosoftReadTool('outlook_read', { message_id: 'm1' }, 'agent-1', 'Agent One');
    expect(out).toContain('Tom & Jerry');
    expect(out).toContain('Second line');
    expect(out).not.toContain('MsoNormal');
    expect(out).not.toContain('&amp;');
    expect(out).toMatch(/Tom & Jerry\n\s*Second line/);
  });

  it('a text body passes through untouched', async () => {
    const literal = 'Literal &amp; text, <style>p{x}</style> tags and\nnewlines stay';
    outlookBody = { contentType: 'text', content: literal };
    const out = await executeMicrosoftReadTool('outlook_read', { message_id: 'm1' }, 'agent-1', 'Agent One');
    expect(out).toContain(literal);
  });
});

describe('teams_read_messages — a chat message reads as clean text', () => {
  it('drops the style block, decodes &nbsp;, keeps the line break', async () => {
    const out = await executeMicrosoftReadTool('teams_read_messages', { chat_id: 'chat1' }, 'agent-1', 'Agent One');
    expect(out).toContain('Standup notes');
    expect(out).toContain('Blocked on the API');
    expect(out).not.toContain('MsoInfobox');
    expect(out).not.toContain('&nbsp;');
    expect(out).toMatch(/Standup notes\n\s*Blocked on the API/);
  });
});

describe('teams_read_channel_messages — a channel message reads as clean text', () => {
  it('drops the style block, decodes &nbsp;, keeps the paragraph break', async () => {
    const out = await executeMicrosoftReadTool('teams_read_channel_messages', { team_id: 'team1', channel_id: 'chan1' }, 'agent-1', 'Agent One');
    expect(out).toContain('Deploy done');
    expect(out).toContain('Review tomorrow');
    expect(out).not.toContain('font-family');
    expect(out).not.toContain('&nbsp;');
    expect(out).toMatch(/Deploy done\n\s*Review tomorrow/);
  });
});
