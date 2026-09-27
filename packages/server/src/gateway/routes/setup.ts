import { Hono } from 'hono';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { getDb } from '../../db/connection.js';
import {
  getDashboardPasswordHash,
  setDashboardPassword,
  getJwtSecret,
} from '../../config/loader.js';
import { isPastFirstRun, markFirstRunComplete } from '../../config/setup-state.js';
import { LoginSchema } from '../../config/schema.js';
import { createLogger } from '../../logger.js';
import { isPMEnabled, isTrainerEnabled, getPrimaryAgentId } from '../../config/platform.js';
import type { SetupStatus } from '@dojo/shared';
import type { AppEnv } from '../server.js';

const logger = createLogger('setup');

const SALT_ROUNDS = 12;
const JWT_EXPIRY = '24h';

const setupRouter = new Hono<AppEnv>();

// The setup router is reachable without a token during the out-of-box
// experience (a fresh machine has no credential to present). Since PHASE-0 T9
// the auth middleware shuts that window the moment first run is over, and
// `isPastFirstRun()` — one authority, shared with the middleware, in
// config/setup-state.ts — is what both consult. The per-route refusals below
// stay as the second, in-handler layer: these two routes mint an admin JWT and
// overwrite the dashboard password, so they refuse on their own account rather
// than trusting the door to have been shut. Read-only /status is always public
// (the login screen reads it pre-token to decide wizard vs login).

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

  // The authoritative first-run signal is the same one the auth middleware
  // uses, so the dashboard can never be shown a wizard whose routes 401.
  // Falling back to the real provider/model counts keeps installs that were set
  // up before the flag existed (legacy upgrades) out of the wizard.
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

// POST /password: set password during setup (first-run only)
setupRouter.post('/password', async (c) => {
  if (isPastFirstRun()) {
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
  if (isPastFirstRun()) {
    // Already completed: this route must never mint an admin JWT again, or it
    // is an unauthenticated auth-bypass. Real logins go through /api/auth/login.
    return c.json({ ok: false, error: 'Setup is already complete' }, 403);
  }
  const storedHash = getDashboardPasswordHash();
  if (!storedHash) {
    return c.json({ ok: false, error: 'Password must be set before completing setup' }, 400);
  }

  // ── PROVISION-FIRST, ENFORCED (fresh-box audit, finding 3) ──────────────────────────────
  // Everything below this line depends on the primary agent existing: `agents.parent_agent`
  // references it, so all five residents refuse without it. This route used to run the whole
  // block anyway and log that they had spawned, which was false — the audited fresh box ended up
  // with ZERO agents, five residents retrying every 5 seconds forever, and a success line in the
  // log. Only a restart cured it, because the boot path creates the primary.
  //
  // REFUSING IS THE RECOVERABLE ANSWER and completing is not: refuse and the box is still in OOBE,
  // so the caller can provision and come straight back. Complete without a primary and the OOBE
  // window is shut (`markFirstRunComplete()` below), which is why a restart was the only way out.
  // The shipped wizard already calls `provision-agent` first, so this changes nothing for it —
  // it closes the door on the abort, the reload and the non-UI client.
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

  // Mark setup as completed — writes the durable flag AND shuts the OOBE
  // window in this process (config/setup-state.ts).
  markFirstRunComplete();

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
  } catch (err) {
    logger.error('Failed to ensure Healer agent', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Ensure Dreamer agent exists (permanent resident)
  try {
    const { ensureDreamerAgentRunning } = await import('../../vault/maintenance.js');
    ensureDreamerAgentRunning();
  } catch (err) {
    logger.error('Failed to ensure Dreamer agent', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // WHAT ACTUALLY EXISTS, read rather than assumed. The four lines this replaces each claimed a
  // resident had spawned immediately after calling its ensure function, without looking — and on
  // the audited box all four were false. One statement of the measured truth beats four guesses.
  const residents = (getDb().prepare(
    "SELECT id FROM agents WHERE status != 'terminated' ORDER BY id",
  ).all() as Array<{ id: string }>).map(r => r.id);
  logger.info('Setup completion finished; agents now present', {
    count: residents.length, agents: residents,
  });

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
