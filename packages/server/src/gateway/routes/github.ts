// GitHub settings routes (status, connect, cancel, disconnect) over device flow, which has no
// callback route, so nothing is added to `ALWAYS_PUBLIC_PATHS`. No handler can return the token:
// none imports `getGithubToken` and `GithubStatus` has no token field.

import { Hono } from 'hono';
import type { AppEnv } from '../server.js';
import { disconnectGithub } from '../../github/account.js';
import { cancelDeviceFlow, startDeviceFlow } from '../../github/device-flow.js';
import { githubStatus } from '../../github/status.js';
import { broadcast } from '../ws.js';

export const githubRouter = new Hono<AppEnv>();

githubRouter.get('/status', (c) => {
  return c.json({ ok: true, data: githubStatus() });
});

githubRouter.post('/connect', async (c) => {
  const started = await startDeviceFlow();
  if (!started.ok) {
    // An unregistered OAuth App answers a sentence so the card can show "not set up yet".
    return c.json({ ok: false, error: started.error }, 400);
  }
  const { userCode, verificationUri, expiresAt, intervalMs } = started.state;
  return c.json({ ok: true, data: { userCode, verificationUri, expiresAt, intervalMs } });
});

githubRouter.post('/cancel-connect', (c) => {
  cancelDeviceFlow();
  return c.json({ ok: true, data: { cancelled: true } });
});

githubRouter.post('/disconnect', (c) => {
  // Cancel first: an in-flight sign-in could otherwise land a token after Disconnect.
  cancelDeviceFlow();
  disconnectGithub();
  broadcast({ type: 'github:disconnected' });
  return c.json({ ok: true, data: { disconnected: true } });
});
