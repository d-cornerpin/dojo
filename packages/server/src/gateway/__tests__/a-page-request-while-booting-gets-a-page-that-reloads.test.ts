// While the Dojo starts, a browser asking for a page gets a small page that reloads itself; an API caller
// (the watchdog, the installer's probe) still gets the JSON 503 it reads as "not up yet".
import { describe, it, expect } from 'vitest';
import { startingAnswer } from '../starting-page.js';

describe('a page request while booting', () => {
  it('gets a page that says the Dojo is starting and reloads itself', async () => {
    const res = startingAnswer(new Request('http://localhost:3001/', { headers: { accept: 'text/html,application/xhtml+xml' } }));
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toMatch(/Dojo is starting/);
    expect(body).toMatch(/http-equiv="refresh"/);
  });

  it('an API request keeps the JSON answer', async () => {
    const res = startingAnswer(new Request('http://localhost:3001/api/health'));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'Dojo is starting' });
  });
});
