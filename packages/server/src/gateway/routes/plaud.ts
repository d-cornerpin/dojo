// ════════════════════════════════════════
// Plaud Settings Routes
// Drives the Settings → Integrations → Plaud card: status polling,
// connect (interactive OAuth via CLI subprocess), and disconnect.
// ════════════════════════════════════════

import { Hono } from 'hono';
import type { AppEnv } from '../server.js';
import {
  getPlaudStatus,
  startPlaudLogin,
  cancelPlaudLogin,
  plaudLogout,
  refreshPlaudAccountInfo,
} from '../../plaud/auth.js';

export const plaudRouter = new Hono<AppEnv>();

plaudRouter.get('/status', (c) => {
  return c.json({ ok: true, data: getPlaudStatus() });
});

// Force-refresh the connection state from Plaud (runs `plaud me`). Useful
// when the dashboard wants to verify the token is still valid.
plaudRouter.post('/refresh', async (c) => {
  const info = await refreshPlaudAccountInfo();
  return c.json({ ok: true, data: { connected: Boolean(info), email: info?.email ?? null } });
});

plaudRouter.post('/connect', async (c) => {
  const result = await startPlaudLogin();
  if (!result.started && result.alreadyRunning) {
    return c.json({
      ok: true,
      data: {
        status: 'already_in_progress',
        message: 'A Plaud login is already in progress. The auth URL is broadcast via the plaud:auth_url WebSocket event.',
      },
    });
  }
  return c.json({
    ok: true,
    data: {
      status: 'started',
      message: 'Plaud login subprocess started. Listen for plaud:auth_url WebSocket event for the URL to open.',
    },
  });
});

plaudRouter.post('/cancel-connect', (c) => {
  const result = cancelPlaudLogin();
  return c.json({ ok: true, data: result });
});

plaudRouter.post('/disconnect', async (c) => {
  const result = await plaudLogout();
  if (!result.ok) {
    return c.json({ ok: false, error: result.error ?? 'Plaud logout failed.' }, 500);
  }
  return c.json({ ok: true, data: { disconnected: true } });
});
