// ════════════════════════════════════════════════════════════════════════════
// THE TUNNEL TOKEN IS NOT SAVED WHEN A BAD URL ERRORS.
//
// `POST /tunnel/token` stored the token, then handed a non-string `url` to
// `setNamedTunnelUrl` — which trims it — so the owner got a 500 while the new
// token was already saved. The url must be checked BEFORE any write, and the
// token must be a non-empty string (a number or object was handed straight to
// `setTunnelToken`). `POST /tunnel/named-url` threw the same way for a
// non-string url; null/undefined still clear the saved url.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { setTunnelToken, setNamedTunnelUrl } = vi.hoisted(() => ({
  setTunnelToken: vi.fn(),
  setNamedTunnelUrl: vi.fn(),
}));

vi.mock('../../../services/tunnel.js', () => ({
  getTunnelStatus: () => ({ enabled: false, mode: 'quick', status: 'inactive', url: null, error: null, startedAt: null, cloudflaredInstalled: false }),
  enableTunnel: () => ({ ok: true }),
  disableTunnel: () => {},
  startTunnel: () => ({ ok: true }),
  stopTunnel: () => {},
  isCloudflaredInstalled: () => false,
  installCloudflared: () => ({ ok: true }),
  setTunnelToken,
  setNamedTunnelUrl,
}));

import { servicesRouter } from '../services.js';

const post = (path: string, body: unknown): Promise<Response> =>
  servicesRouter.request(path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });

beforeEach(() => {
  setTunnelToken.mockClear();
  setNamedTunnelUrl.mockClear();
});

describe('the tunnel token and url are checked before saving', () => {
  it('⚠ a non-string url is a 400 and the token is not saved', async () => {
    const res = await post('/tunnel/token', { token: 'tok', url: 42 });
    expect(res.status).toBe(400);
    expect(setTunnelToken).not.toHaveBeenCalled();
    expect(setNamedTunnelUrl).not.toHaveBeenCalled();
  });

  it('⚠ a non-string token is a 400 and nothing is saved', async () => {
    const res = await post('/tunnel/token', { token: 42 });
    expect(res.status).toBe(400);
    expect(setTunnelToken).not.toHaveBeenCalled();
    expect(setNamedTunnelUrl).not.toHaveBeenCalled();
  });

  it('⚠ a non-string url on named-url is a 400 and the url is not saved', async () => {
    const res = await post('/tunnel/named-url', { url: { a: 1 } });
    expect(res.status).toBe(400);
    expect(setNamedTunnelUrl).not.toHaveBeenCalled();
  });

  it('a valid token and url saves both', async () => {
    const res = await post('/tunnel/token', { token: 'tok', url: 'https://example.test/' });
    expect(res.status).toBe(200);
    expect(setTunnelToken).toHaveBeenCalledWith('tok');
    expect(setNamedTunnelUrl).toHaveBeenCalledWith('https://example.test/');
  });

  it('a null url on named-url clears it', async () => {
    const res = await post('/tunnel/named-url', { url: null });
    expect(res.status).toBe(200);
    expect(setNamedTunnelUrl).toHaveBeenCalledWith(null);
  });
});
