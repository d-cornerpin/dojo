import { Hono } from 'hono';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { getDb } from '../../db/connection.js';
import {
  getDashboardPasswordHash,
  setDashboardPassword,
  getJwtSecret,
} from '../../config/loader.js';
import { LoginSchema } from '../../config/schema.js';
import { createLogger } from '../../logger.js';
import { isPMEnabled, isTrainerEnabled } from '../../config/platform.js';
import type { SetupStatus } from '@dojo/shared';
import type { AppEnv } from '../server.js';

const logger = createLogger('setup');

const SALT_ROUNDS = 12;
const JWT_EXPIRY = '24h';

const setupRouter = new Hono<AppEnv>();

// GET /status
setupRouter.get('/status', (c) => {
  const db = getDb();

  const providerCount = (
    db.prepare('SELECT COUNT(*) as count FROM providers').get() as { count: number }
  ).count;
  const enabledModelCount = (
    db.prepare('SELECT COUNT(*) as count FROM models WHERE is_enabled = 1').get() as {
      count: number;
    }
  ).count;
  const hasPassword = getDashboardPasswordHash() !== null;

  const status: SetupStatus = {
    isFirstRun: providerCount === 0 || enabledModelCount === 0,
    steps: {
      providers: providerCount > 0,
      models: enabledModelCount > 0,
      identity: hasPassword,
    },
  };

  return c.json({ ok: true, data: status });
});

// POST /password — set password during setup
setupRouter.post('/password', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = LoginSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: 'Password is required' }, 400);
  }

  const { password } = parsed.data;
  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  setDashboardPassword(hash);
  logger.info('Dashboard password set via setup');

  return c.json({ ok: true, data: { message: 'Password set' } });
});

// POST /complete — finalize setup, return JWT
setupRouter.post('/complete', async (c) => {
  const storedHash = getDashboardPasswordHash();
  if (!storedHash) {
    return c.json({ ok: false, error: 'Password must be set before completing setup' }, 400);
  }

  const secret = getJwtSecret();
  const token = jwt.sign({ userId: 'admin' }, secret, { expiresIn: JWT_EXPIRY });

  c.header(
    'Set-Cookie',
    `token=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=86400`,
  );

  // Mark setup as completed
  const db = getDb();
  db.prepare("INSERT INTO config (key, value, updated_at) VALUES ('setup_completed', 'true', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = datetime('now')").run();

  // Clear platform config cache so it picks up OOBE values
  const { clearPlatformConfigCache } = await import('../../config/platform.js');
  clearPlatformConfigCache();

  // Ensure system group and assign permanent agents
  try {
    const { ensureSystemGroup } = await import('../../agent/groups.js');
    ensureSystemGroup();
  } catch { /* ignore */ }

  // Spawn PM agent if enabled
  if (isPMEnabled()) {
    try {
      const { ensurePMAgentRunning } = await import('../../tracker/pm-agent.js');
      ensurePMAgentRunning();
      logger.info('PM agent spawned during setup completion');
    } catch (err) {
      logger.error('Failed to spawn PM agent', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Spawn Trainer agent if enabled
  if (isTrainerEnabled()) {
    try {
      const { ensureTrainerAgentRunning } = await import('../../techniques/trainer-agent.js');
      ensureTrainerAgentRunning();
      logger.info('Trainer agent spawned during setup completion');
    } catch (err) {
      logger.error('Failed to spawn Trainer agent', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Re-run system group assignment now that all agents exist
  try {
    const { ensureSystemGroup: reassignGroups } = await import('../../agent/groups.js');
    reassignGroups();
    logger.info('System group re-assigned after agent creation');
  } catch { /* ignore */ }

  logger.info('Setup completed');

  return c.json({ ok: true, data: { token } });
});

export { setupRouter };
