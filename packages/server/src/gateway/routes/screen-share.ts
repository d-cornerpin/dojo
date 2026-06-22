// ════════════════════════════════════════
// Screen Share API Routes
// Drives the Settings > Screen Sharing panel: status, enable (with no-clobber
// detection), set-dedicated-password, and disable. JWT-protected via the mount.
// ════════════════════════════════════════

import { Hono } from 'hono';
import { createLogger } from '../../logger.js';
import {
  getStatus,
  enable,
  disable,
  saveVncPassword,
  getSavedVncPassword,
  clearSavedVncPassword,
} from '../../screen-share/manager.js';

const logger = createLogger('screen-share-routes');
const screenShareRouter = new Hono();

// GET /status — current feature + service state (never returns the password)
screenShareRouter.get('/status', async (c) => {
  return c.json({ ok: true, data: await getStatus() });
});

// POST /enable — use existing Screen Sharing or turn it on (admin prompt on the
// Mac). No password is stored; users authenticate with their Mac login.
screenShareRouter.post('/enable', async (c) => {
  try {
    const result = await enable();
    return c.json({ ok: true, data: result });
  } catch (err) {
    logger.error('enable failed', { error: err instanceof Error ? err.message : String(err) });
    return c.json({ ok: false, error: 'Enable failed' }, 500);
  }
});

// POST /disable — turn the feature off; only reverts macOS Screen Sharing if the
// dojo was the one that enabled it.
screenShareRouter.post('/disable', async (c) => {
  try {
    const result = await disable();
    return c.json({ ok: true, data: { success: result.ok, status: result.status, error: result.error } });
  } catch (err) {
    logger.error('disable failed', { error: err instanceof Error ? err.message : String(err) });
    return c.json({ ok: false, error: 'Disable failed' }, 500);
  }
});

// GET /vnc-password — the user's saved VNC password (or null) for auto-fill.
// Behind JWT; returned only to the authenticated dashboard for the user's own
// connection. Empty unless the user explicitly opted to save it.
screenShareRouter.get('/vnc-password', (c) => {
  return c.json({ ok: true, data: { password: getSavedVncPassword() } });
});

// POST /vnc-password — save the VNC password after a successful connect (opt-in).
screenShareRouter.post('/vnc-password', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!password) return c.json({ ok: false, error: 'password is required' }, 400);
  saveVncPassword(password);
  return c.json({ ok: true, data: { saved: true } });
});

// DELETE /vnc-password — forget the saved password (manual, or after it fails).
screenShareRouter.delete('/vnc-password', (c) => {
  clearSavedVncPassword();
  return c.json({ ok: true, data: { saved: false } });
});

export { screenShareRouter };
