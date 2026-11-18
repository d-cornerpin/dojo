// A failed request through the door carries the HTTP status of the answer, so a caller can tell
// "the server says it is not there" (404) from "the request never got an answer" (no status).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { request } from '../lib/door';

const answer = (status: number, body: string) => vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })));
afterEach(() => { vi.unstubAllGlobals(); });

describe('the door keeps the HTTP status', () => {
  it('on a JSON error answer', async () => {
    answer(404, JSON.stringify({ ok: false, error: 'Agent not found' }));
    expect(await request('/agents/x')).toMatchObject({ ok: false, error: 'Agent not found', status: 404 });
  });
  it('on a non-JSON error answer', async () => {
    answer(502, '<html>bad gateway</html>');
    expect(await request('/agents/x')).toMatchObject({ ok: false, status: 502 });
  });
  it('leaves successes alone and gives a dead network no status', async () => {
    answer(200, JSON.stringify({ ok: true, data: { a: 1 } }));
    expect(await request('/x')).toEqual({ ok: true, data: { a: 1 } });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    const r = await request('/x');
    expect(r).toEqual({ ok: false, error: 'The Dojo could not be reached. Check that it is running, then try again.' });
  });
});
