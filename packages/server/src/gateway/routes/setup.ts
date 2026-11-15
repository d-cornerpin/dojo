import { Hono } from 'hono';
import jwt from 'jsonwebtoken';
import { getDb } from '../../db/connection.js';
import {
  getDashboardPasswordHash,
  getJwtSecret,
} from '../../config/loader.js';
import { isPastFirstRun, markFirstRunComplete } from '../../config/setup-state.js';
import { createLogger } from '../../logger.js';
import { getPrimaryAgentId } from '../../config/platform.js';
import type { SetupStatus } from '@dojo/shared';
import type { AppEnv } from '../server.js';

const logger = createLogger('setup');

const JWT_EXPIRY = '24h';

const setupRouter = new Hono<AppEnv>();

// Reachable without a token during first run only (a fresh box has no credential); isPastFirstRun() is the
// one authority the auth middleware also consults. /complete mints a JWT, so it also refuses on its own account.
// Read-only /status is always public (the login screen reads it pre-token).

setupRouter.get('/status', (c) => {
  const db = getDb();

  // Count only real providers/models, not the sentinels seeded on every fresh DB (the '__system__' provider
  // and the enabled 'auto' model), or a brand-new install would look already configured.
  const providerCount = (
    db.prepare("SELECT COUNT(*) as count FROM providers WHERE id != '__system__'").get() as { count: number }
  ).count;
  const enabledModelCount = (
    db.prepare("SELECT COUNT(*) as count FROM models WHERE is_enabled = 1 AND id != 'auto'").get() as {
      count: number;
    }
  ).count;
  const hasPassword = getDashboardPasswordHash() !== null;

  // Same first-run signal as the auth middleware, so the dashboard is never shown a wizard whose routes 401;
  // the real provider/model counts keep installs that predate the flag out of the wizard.
  const status: SetupStatus = {
    isFirstRun: !isPastFirstRun() && providerCount === 0 && enabledModelCount === 0,
    steps: {
      providers: providerCount > 0,
      models: enabledModelCount > 0,
      identity: hasPassword,
    },
  };

  return c.json({ ok: true, data: status });
});

// POST /complete: finalize setup, return JWT (first-run only)
setupRouter.post('/complete', async (c) => {
  if (isPastFirstRun()) {
    // Must never mint an admin JWT again once setup is complete (an unauthenticated auth bypass).
    // Real logins go through /api/auth/login.
    return c.json({ ok: false, error: 'Setup is already complete' }, 403);
  }
  const storedHash = getDashboardPasswordHash();
  if (!storedHash) {
    return c.json({ ok: false, error: 'Password must be set before completing setup' }, 400);
  }

  // Everything below needs the primary agent (`agents.parent_agent` references it), so refuse before marking
  // first run complete: a refused box is still in OOBE and can provision and return, a completed one has shut
  // that window.
  const primaryId = getPrimaryAgentId();
  if (!getDb().prepare('SELECT id FROM agents WHERE id = ?').get(primaryId)) {
    logger.warn('Refused to complete setup: no primary agent exists yet', { primaryId });
    return c.json({
      ok: false,
      error: 'Setup cannot complete before the primary agent is created, because every other '
        + 'agent is parented to it. Create it first (POST /api/setup/provision-agent, which the '
        + 'setup wizard calls for you) and then complete setup.',
    }, 400);
  }

  const secret = getJwtSecret();
  const token = jwt.sign({ userId: 'admin' }, secret, { expiresIn: JWT_EXPIRY });

  c.header(
    'Set-Cookie',
    `token=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=86400`,
  );

  // Writes the durable flag and shuts the OOBE window in this process.
  markFirstRunComplete();

  const { clearPlatformConfigCache } = await import('../../config/platform.js');
  clearPlatformConfigCache();

  try {
    const { ensureSystemGroup } = await import('../../agent/groups.js');
    ensureSystemGroup();
  } catch { /* ignore */ }

  try {
    const { ensurePMAgentRunning } = await import('../../tracker/pm-agent.js');
    ensurePMAgentRunning();
  } catch (err) {
    logger.error('Failed to spawn PM agent', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const { ensureTrainerAgentRunning } = await import('../../techniques/trainer-agent.js');
    ensureTrainerAgentRunning();
  } catch (err) {
    logger.error('Failed to spawn Trainer agent', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const { ensureHealerAgentRunning } = await import('../../healer/healer-agent.js');
    ensureHealerAgentRunning();
  } catch (err) {
    logger.error('Failed to ensure Healer agent', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const { ensureDreamerAgentRunning } = await import('../../vault/maintenance.js');
    ensureDreamerAgentRunning();
  } catch (err) {
    logger.error('Failed to ensure Dreamer agent', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Log the agents that actually exist rather than assuming each ensure call spawned its resident.
  const residents = (getDb().prepare(
    "SELECT id FROM agents WHERE status != 'terminated' ORDER BY id",
  ).all() as Array<{ id: string }>).map(r => r.id);
  logger.info('Setup completion finished; agents now present', {
    count: residents.length, agents: residents,
  });

  try {
    const { ensureSystemGroup: reassignGroups } = await import('../../agent/groups.js');
    reassignGroups();
    logger.info('System group re-assigned after agent creation');
  } catch { /* ignore */ }

  try {
    const { scheduleDreamingCycle } = await import('../../vault/maintenance.js');
    scheduleDreamingCycle();
  } catch { /* ignore */ }

  // Boot starts the scheduler only when setup was already complete, so on a fresh box this is the only start;
  // it is idempotent.
  try {
    const { startScheduler } = await import('../../scheduler/clock.js');
    startScheduler();
  } catch (err) {
    logger.error('Failed to start the scheduler clock after setup', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

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
