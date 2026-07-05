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

// The setup router is a PUBLIC prefix (first-run OOBE happens before any
// credential exists). That means every state-changing route here MUST refuse
// once first-run is over, or it becomes an unauthenticated admin surface: an
// internet-reachable client (e.g. over the cloudflared tunnel) could otherwise
// overwrite the dashboard password or mint an admin JWT with no credential.
// `setup_completed` is written once at the end of POST /complete and never
// unset. Read-only /status stays public (the dashboard polls it to decide
// whether to show the wizard).
function isSetupCompleted(): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM config WHERE key = 'setup_completed'")
    .get() as { value: string } | undefined;
  return row?.value === 'true';
}

// GET /status
setupRouter.get('/status', (c) => {
  const db = getDb();

  // Count only REAL providers/models, not the internal sentinels seeded on
  // every fresh DB (the '__system__' provider + the enabled 'auto' router
  // model). Counting those made a brand-new install look already-configured,
  // which is why OOBE stopped appearing on first run.
  const providerCount = (
    db.prepare("SELECT COUNT(*) as count FROM providers WHERE id != '__system__'").get() as { count: number }
  ).count;
  const enabledModelCount = (
    db.prepare("SELECT COUNT(*) as count FROM models WHERE is_enabled = 1 AND id != 'auto'").get() as {
      count: number;
    }
  ).count;
  const hasPassword = getDashboardPasswordHash() !== null;

  // The authoritative first-run signal is the explicit `setup_completed` flag
  // written when OOBE finishes (see POST /complete). Falling back to the real
  // provider/model counts keeps installs that were set up before that flag
  // existed (legacy upgrades) out of the wizard.
  const setupCompleted =
    (db.prepare("SELECT value FROM config WHERE key = 'setup_completed'").get() as { value: string } | undefined)
      ?.value === 'true';

  const status: SetupStatus = {
    isFirstRun: !setupCompleted && providerCount === 0 && enabledModelCount === 0,
    steps: {
      providers: providerCount > 0,
      models: enabledModelCount > 0,
      identity: hasPassword,
    },
  };

  return c.json({ ok: true, data: status });
});

// POST /password: set password during setup (first-run only)
setupRouter.post('/password', async (c) => {
  if (isSetupCompleted()) {
    // Not a first-run box: changing the password requires authentication via
    // the authenticated change-password flow, not this public route.
    return c.json({ ok: false, error: 'Setup is already complete' }, 403);
  }
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

// POST /complete: finalize setup, return JWT (first-run only)
setupRouter.post('/complete', async (c) => {
  if (isSetupCompleted()) {
    // Already completed: this route must never mint an admin JWT again, or it
    // is an unauthenticated auth-bypass. Real logins go through /api/auth/login.
    return c.json({ ok: false, error: 'Setup is already complete' }, 403);
  }
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

  // Ensure Healer agent exists (permanent resident)
  try {
    const { ensureHealerAgentRunning } = await import('../../healer/healer-agent.js');
    ensureHealerAgentRunning();
    logger.info('Healer agent ensured during setup completion');
  } catch (err) {
    logger.error('Failed to ensure Healer agent', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Ensure Dreamer agent exists (permanent resident)
  try {
    const { ensureDreamerAgentRunning } = await import('../../vault/maintenance.js');
    ensureDreamerAgentRunning();
    logger.info('Dreamer agent ensured during setup completion');
  } catch (err) {
    logger.error('Failed to ensure Dreamer agent', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Re-run system group assignment now that all agents exist
  try {
    const { ensureSystemGroup: reassignGroups } = await import('../../agent/groups.js');
    reassignGroups();
    logger.info('System group re-assigned after agent creation');
  } catch { /* ignore */ }

  // Schedule the nightly dreaming cycle
  try {
    const { scheduleDreamingCycle } = await import('../../vault/maintenance.js');
    scheduleDreamingCycle();
  } catch { /* ignore */ }

  // Run first-run profile bootstrap (Dreamer processes USER.md into vault)
  try {
    const { runFirstRunProfileBootstrap } = await import('../../vault/maintenance.js');
    runFirstRunProfileBootstrap().catch(err => {
      logger.error('First-run profile bootstrap failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    logger.info('First-run profile bootstrap initiated');
  } catch { /* ignore */ }

  logger.info('Setup completed');

  return c.json({ ok: true, data: { token } });
});

export { setupRouter };
