// FIX F6 regression: googleFetch must parse JSON responses as JSON but hand
// non-JSON responses (alt=media raw file downloads: text, markdown, binary)
// back as a raw string, instead of unconditionally calling resp.json(), which
// threw "Unexpected token ... is not valid JSON" and failed drive_read on every
// plain-text file. The buggy version's json() call sits inside googleFetch's
// try/catch, so a wrong parse surfaces as { ok: false }; these tests assert the
// success + raw-string behavior that only the content-aware parse produces.

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../auth.js', () => ({
  getValidAccessTokenForAccount: vi.fn(async () => 'fake-access-token'),
}));

vi.mock('../accounts.js', () => ({
  getGoogleAccount: vi.fn(() => ({ id: 'agent', kind: 'agent', email: 'agent@example.com' })),
}));

vi.mock('../activity-log.js', () => ({
  logGoogleActivity: vi.fn(),
}));

vi.mock('../../gateway/ws.js', () => ({
  broadcast: vi.fn(),
}));

import { googleRead } from '../client.js';

function fakeResponse(opts: { body: string; contentType: string; status?: number }): Response {
  const status = opts.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? opts.contentType : null),
    },
    // A real Response.json() throws on a non-JSON body. Model that, so the test
    // proves we do NOT call json() on non-JSON responses.
    json: async () => JSON.parse(opts.body),
    text: async () => opts.body,
  } as unknown as Response;
}

describe('googleFetch content-aware parse (F6)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses a JSON response into an object', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({
      body: JSON.stringify({ files: [{ id: '1', name: 'a.txt' }] }),
      contentType: 'application/json; charset=UTF-8',
    })));
    const result = await googleRead('https://example.com/list', 'agent-1', 'agent', 'drive_list', {});
    expect(result.ok).toBe(true);
    expect(typeof result.data).toBe('object');
    expect((result.data as { files: unknown[] }).files).toHaveLength(1);
  });

  it('returns a text/markdown response as the raw string (not parsed)', async () => {
    const raw = '# Heading\n\nplain text body, not JSON';
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({
      body: raw,
      contentType: 'text/markdown',
    })));
    const result = await googleRead('https://example.com/file?alt=media', 'agent-1', 'agent', 'drive_read', {});
    expect(result.ok).toBe(true);
    expect(result.data).toBe(raw);
  });

  it('does not throw on a small binary-ish (octet-stream) response', async () => {
    const raw = '\x00\x01\x02not-valid-json\xff';
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({
      body: raw,
      contentType: 'application/octet-stream',
    })));
    const result = await googleRead('https://example.com/file?alt=media', 'agent-1', 'agent', 'drive_read', {});
    expect(result.ok).toBe(true);
    expect(typeof result.data).toBe('string');
    expect(result.data).toBe(raw);
  });
});
