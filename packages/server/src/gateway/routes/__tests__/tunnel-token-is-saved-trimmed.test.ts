// ════════════════════════════════════════════════════════════════════════════
// THE TUNNEL TOKEN IS SAVED TRIMMED.
//
// `POST /tunnel/token` checked `body.token.trim()` for blankness and then saved
// `body.token` exactly as pasted. A token copied from the Cloudflare page often
// carries a trailing space or line break; saved as is, cloudflared refuses it
// and the failure does not point at the paste. The url beside it is already
// trimmed by `setNamedTunnelUrl` — the token must be trimmed too.
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

describe('the tunnel token is saved trimmed', () => {
  it('⚠ a token pasted with surrounding whitespace is saved without it', async () => {
    const res = await post('/tunnel/token', { token: '  abc123\n' });
    expect(res.status).toBe(200);
    expect(setTunnelToken).toHaveBeenCalledTimes(1);
    expect(setTunnelToken).toHaveBeenCalledWith('abc123');
  });
});
