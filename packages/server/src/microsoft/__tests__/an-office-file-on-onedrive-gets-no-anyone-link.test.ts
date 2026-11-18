// A Word, Excel or PowerPoint file the agent edits (or makes) on OneDrive stays as private as the folder it
// is in: no "anyone with the link" link is made. A link is made only when the agent is asked to share.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import JSZip from 'jszip';

vi.mock('../auth.js', () => ({
  getValidAccessTokenForAccount: vi.fn(async (id: string) => `token-for-${id}`),
}));
vi.mock('../accounts.js', () => ({
  listMicrosoftAccounts: () => [{ id: 'agent-acct', kind: 'agent', email: 'agent@example.com', connected: true }],
}));
vi.mock('../activity-log.js', () => ({ logMicrosoftActivity: vi.fn() }));
vi.mock('../graph-fetch.js', () => ({ GRAPH_BASE: 'https://graph.test/v1.0', graphFetch: vi.fn() }));

import { graphFetch } from '../graph-fetch.js';
import { executeOfficeTool } from '../tools-office.js';

const DOC = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Helo there</w:t></w:r></w:p></w:body></w:document>';

beforeEach(async () => {
  const docx = await new JSZip().file('word/document.xml', DOC).generateAsync({ type: 'nodebuffer' });
  vi.mocked(graphFetch).mockReset();
  vi.mocked(graphFetch).mockImplementation((async (_agent: unknown, url: string, init?: RequestInit) => {
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
    if (url.includes('?$select=name,parentReference')) return json({ name: 'Notes.docx', parentReference: { id: 'folder-1' } });
    if (url.endsWith('/content') && init?.method !== 'PUT') return { ok: true, status: 200, arrayBuffer: async () => docx };
    if (url.includes('createLink')) return json({ link: { webUrl: 'https://1drv.example.com/anyone' } });
    return json({ id: 'file-1', name: 'Notes.docx', webUrl: 'https://onedrive.example.com/file-1' });
  }) as never);
});

describe('an office file on OneDrive', () => {
  it('a typo fixed in a Word file is saved back with no anyone-with-the-link link', async () => {
    const out = await executeOfficeTool('office_replace_in_word_document', { file_id: 'file-1', find: 'Helo', replace: 'Hello' }, 'agent-main', 'Main');
    expect(out).toContain('Replaced 1 occurrence(s)');
    const urls = vi.mocked(graphFetch).mock.calls.map((c) => String(c[1]));
    expect(urls.some((u) => u.endsWith(':/content'))).toBe(true);
    expect(urls.some((u) => u.includes('createLink'))).toBe(false);
  });
});
