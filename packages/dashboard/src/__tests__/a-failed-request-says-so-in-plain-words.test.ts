import { describe, it, expect, vi, afterEach } from 'vitest';
import { request } from '../lib/door';

afterEach(() => { vi.unstubAllGlobals(); });

describe('a failed request says so in plain words', () => {
  it('a dead network', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await request('/x')).toEqual({ ok: false, error: 'The Dojo could not be reached. Check that it is running, then try again.' });
  });
  it('an empty answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502 })));
    expect(await request('/x')).toMatchObject({ ok: false, error: 'The Dojo sent back an empty answer. Try again.', status: 502 });
  });
  it('an answer that is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>bad gateway</html>', { status: 500 })));
    expect(await request('/x')).toMatchObject({ ok: false, status: 500, error: 'The Dojo sent back an answer the dashboard could not read. Try again, or restart the Dojo if it keeps happening.' });
  });
});
