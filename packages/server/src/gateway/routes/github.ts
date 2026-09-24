// ════════════════════════════════════════════════════════════════════════════════════════
// GITHUB SETTINGS ROUTES (DOJO-REPORT T4).
//
// Drives the Settings → Integrations → GitHub card: status, connect, cancel, disconnect.
// The route set is Plaud's, which is the house's shape for an OUT-OF-BAND connect — the user
// does something somewhere else (there, a CLI; here, github.com/login/device) and the card
// waits for a WebSocket frame rather than a redirect.
//
// ── WHAT IS DELIBERATELY ABSENT ──
// THERE IS NO CALLBACK ROUTE. Device flow has none, which is why nothing is added to
// `ALWAYS_PUBLIC_PATHS` and why this integration works identically over a tunnel while the
// redirect-based ones do not.
//
// ── THE TOKEN IS NOT REACHABLE FROM HERE ──
// No handler in this file imports `getGithubToken`, and `GithubStatus` has no token field, so
// no response body can carry one. That is asserted for real — the suite drives this router and
// reads the bytes of every answer — rather than left as an intention.
// ════════════════════════════════════════════════════════════════════════════════════════

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
    // A box the owner has not registered an OAuth App for answers a SENTENCE, so the card can
    // render "not set up yet" instead of a button that does nothing.
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
  // Cancel first: a sign-in still in flight would otherwise land a token onto a box whose
  // owner just pressed Disconnect, which is the one ordering that could resurrect it.
  cancelDeviceFlow();
  disconnectGithub();
  broadcast({ type: 'github:disconnected' });
  return c.json({ ok: true, data: { disconnected: true } });
});
