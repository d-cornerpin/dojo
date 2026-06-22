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

export { screenShareRouter };
