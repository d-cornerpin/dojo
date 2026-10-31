// A downloaded attachment is saved under whatever name the SENDER gave it — and a
// sender-chosen name must not be able to pick a folder.
//
// The three download tools built the DEFAULT save path with
// `nodePath.join(<agent uploads dir>, <name from the email or chat>)`, and
// `path.join` resolves `..`: an attachment named `../../notes.txt` wrote OUTSIDE
// `~/.dojo/uploads/<agent>/`. Nothing in the product intends a sender's file name
// to choose a folder. The door case below drives `gmail_read_attachment` with a
// mocked Gmail read and a mocked `node:fs`, so nothing touches the real disk; the
// unit cases pin the helper every three tools now share. (An explicit `save_path`
// is the caller's own choice and is unaffected.)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

vi.mock('../client.js', () => ({
  googleRead: vi.fn(),
  googleWrite: vi.fn(async () => ({ ok: true, data: null, error: null, apiEndpoint: 'x' })),
}));
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
vi.mock('../../receipts/store.js', () => ({ writeToolReceipt: vi.fn() }));
// Capture the write instead of performing it. Everything else in fs stays real so
// module-load-time imports of fs keep working. (homeDir() reads DOJO_HOME, which
// vitest.setup.ts already points at this worker's throwaway home — HOME itself is
// not what resolves, so nothing here rebinds it.)
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, writeFileSync: vi.fn(), mkdirSync: vi.fn() };
});

import { googleRead } from '../client.js';
import { executeGoogleWriteTool } from '../tools-write.js';
import { safeAttachmentName } from '../../services/safe-attachment-name.js';
import { homeDir } from '../../home.js';

describe('safeAttachmentName — a sender-chosen name cannot pick a folder', () => {
  it('keeps a normal name', () => {
    expect(safeAttachmentName('report.pdf', 'fallback')).toBe('report.pdf');
  });
  it('strips a relative escape', () => {
    expect(safeAttachmentName('../../x.txt', 'fallback')).toBe('x.txt');
  });
  it('strips Windows-style separators', () => {
    expect(safeAttachmentName('a\\b\\c.txt', 'fallback')).toBe('c.txt');
  });
  it('strips an absolute path', () => {
    expect(safeAttachmentName('/etc/passwd', 'fallback')).toBe('passwd');
  });
  it('falls back on empty, "." and ".."', () => {
    expect(safeAttachmentName('', 'fallback')).toBe('fallback');
    expect(safeAttachmentName('..', 'fallback')).toBe('fallback');
    expect(safeAttachmentName('.', 'fallback')).toBe('fallback');
  });
});

describe('gmail_read_attachment — the default path stays in the uploads folder', () => {
  beforeEach(() => {
    vi.mocked(googleRead).mockReset();
    vi.mocked(googleRead).mockResolvedValue({
      ok: true,
      data: { data: Buffer.from('hi').toString('base64url') },
      apiEndpoint: 'https://gmail.googleapis.com/gmail/v1/users/me/attachments',
    });
    vi.mocked(writeFileSync).mockClear();
    vi.mocked(mkdirSync).mockClear();
  });

  it('a sender-chosen ../../escape.txt is written as <uploads>/<agent-id>/escape.txt', async () => {
    await executeGoogleWriteTool(
      'gmail_read_attachment',
      { message_id: 'm1', attachment_id: 'a1', filename: '../../escape.txt' },
      'agent-1', 'Agent One',
    );
    const uploadsDir = path.join(homeDir(), '.dojo', 'uploads', 'agent-1');
    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const writtenPath = vi.mocked(writeFileSync).mock.calls[0][0] as string;
    expect(path.dirname(writtenPath)).toBe(uploadsDir);
    expect(writtenPath).toBe(path.join(uploadsDir, 'escape.txt'));
  });
});
