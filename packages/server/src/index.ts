import { serve, type ServerType } from '@hono/node-server';
import fs from 'node:fs';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createLogger, setLogBroadcast } from './logger.js';
import { getDb } from './db/connection.js';
import { resetWorkingAgentsToIdleAtBoot } from './agent/agent-status.js';
import { runMigrations } from './db/migrations.js';
import { abandonUnservableAsks } from './work/store.js';
import { reconcileOrphanedClaims } from './work/orphaned-claims.js';
import { reapToolboxGroupsAtBoot } from './agent/effects/toolbox-ledger.js';
import { loadSecrets } from './config/loader.js';
import { createServer } from './gateway/server.js';
import { closeServers, trackRequests } from './gateway/close-servers.js';
import { startingAnswer } from './gateway/starting-page.js';
import { keepMacAwake } from './services/keep-awake.js';
import { broadcast } from './gateway/ws.js';
import { checkTimeouts, reArmSpawnTimeouts } from './agent/spawner.js';
import { killTunnelSync } from './services/tunnel.js';
import { getPrimaryAgentId, getPrimaryAgentName } from './config/platform.js';
import { recordBootAttempt, confirmHealthy, readMarker, synthesizeMigrationBootEpisode } from './update-state.js';
import { probeFsCaseInsensitive, setFsCaseInsensitive } from './agent/path-guards.js';
import { homeDir } from './home.js';
import { notForAgentsReason } from './agent/main-model-floor.js';
import { terminateReaderPool, warmReaderPool } from './memory/reader-pool.js';
import { scheduleFtsHealthCheck, stopFtsRepair } from './memory/fts-health.js';
import { stopBackgroundClocks } from './shutdown-clocks.js';

const logger = createLogger('main');
const PORT = parseInt(process.env.DOJO_PORT ?? '3001', 10);

// How long a self-update boot must stay continuously up before its update-state marker flips to healthy.
const HEALTH_CONFIRM_DELAY_MS = 90_000;

// Applied-migration count (`_migrations`, 0 if absent); the boot sentinel uses it to detect a schema change.
function countAppliedMigrations(): number {
  try {
    const row = getDb().prepare('SELECT COUNT(*) AS c FROM _migrations').get() as { c: number } | undefined;
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

// Count of migration SQL files shipped with this build (same resolution as db/migrations.ts).
function countAvailableMigrationFiles(): number {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const migDir = path.join(here, 'db', 'migrations');
    if (!fs.existsSync(migDir)) return 0;
    return fs.readdirSync(migDir).filter(f => f.endsWith('.sql')).length;
  } catch {
    return 0;
  }
}

// For a self-update boot, re-check the DB after ~90s of uptime and mark the episode healthy; a crash
// before then leaves it to the watchdog.
function scheduleUpdateHealthConfirm(): void {
  const marker = readMarker();
  if (!marker) return;
  if (marker.phase !== 'booting-new' && marker.phase !== 'rolled-back') return;
  if (marker.confirmedHealthyAt) return;
  setTimeout(() => {
    try {
      getDb().prepare('SELECT 1').get();
    } catch (err) {
      logger.warn('D-F health-confirm: DB self-check failed, leaving the update episode open for the watchdog', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (confirmHealthy()) {
      logger.info('D-F health-confirm: self-update boot confirmed healthy, update episode cleared');
    }
  }, HEALTH_CONFIRM_DELAY_MS);
}

// Log uncaught crashes before exiting; still exit so dev-mode (tsx watch) restarts cleanly.
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception, process will exit', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  // Best-effort: this path skips the graceful tunnel shutdown, so kill it here. Must never throw.
  try { killTunnelSync(); } catch { /* never throw from the crash handler */ }
  setTimeout(() => process.exit(1), 100);
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

const PLATFORM_DIRS = [
  path.join(homeDir(), '.dojo'),
  path.join(homeDir(), '.dojo', 'data'),
  path.join(homeDir(), '.dojo', 'logs'),
  path.join(homeDir(), '.dojo', 'prompts'),
  path.join(homeDir(), '.dojo', 'uploads'),
  path.join(homeDir(), '.dojo', 'uploads', 'generated'),
];

function ensureDirectories(): void {
  for (const dir of PLATFORM_DIRS) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      logger.info('Created directory', { path: dir });
    }
  }
}

function ensurePrimaryAgent(): void {
  const db = getDb();
  const primaryId = getPrimaryAgentId();
  const primaryName = getPrimaryAgentName();

  const setupDone = db.prepare("SELECT value FROM config WHERE key = 'setup_completed'").get() as { value: string } | undefined;
  if (!setupDone || setupDone.value !== 'true') {
    logger.info('Setup not completed, skipping primary agent creation (OOBE will handle it)');
    return;
  }

  const existing = db.prepare('SELECT id FROM agents WHERE id = ?').get(primaryId);
  if (existing) {
    logger.info('Primary agent already exists', { id: primaryId, name: primaryName });
    return;
  }

  // Prefer 'auto' so the router picks a working chat-capable model at call time; else pin the first enabled
  // model the one agent-model check accepts (not '__system__'), by display name.
  const autoModel = db.prepare(
    "SELECT id FROM models WHERE id = 'auto' AND is_enabled = 1"
  ).get() as { id: string } | undefined;

  const fallbackModelId = autoModel
    ? autoModel.id
    : (db.prepare(`
        SELECT m.id FROM models m
          JOIN providers p ON p.id = m.provider_id
         WHERE m.is_enabled = 1
           AND p.id != '__system__'
         ORDER BY m.name ASC
      `).all() as Array<{ id: string }>).find((m) => notForAgentsReason(m.id) === null)?.id ?? null;

  db.prepare(`
    INSERT INTO agents (id, name, model_id, system_prompt_path, status, config, created_by, created_by_kind,
                        classification, created_at, updated_at)
    VALUES (?, ?, ?, NULL, 'idle', '{"shareUserProfile":true}', 'system', 'user', 'sensei', datetime('now'), datetime('now'))
  `).run(
    primaryId,
    primaryName,
    fallbackModelId,
  );

  logger.info('Created primary agent', { id: primaryId, name: primaryName, modelId: fallbackModelId ?? 'none' });
}

// The port is the mutual exclusion, so it is taken FIRST: everything after it mutates the real database.
// EADDRINUSE is retried for a bounded window (a restart can overlap its predecessor), then it exits.
const BIND_RETRY_MS = 2_000;
const BIND_MAX_ATTEMPTS = 5;

async function bindPortFirst(fetchHandler: (request: Request, env: unknown) => Response | Promise<Response>): Promise<ServerType> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await new Promise<ServerType>((resolve, reject) => {
        const server = serve({ fetch: fetchHandler, port: PORT }, (info) => {
          server.off('error', reject);
          logger.info(`Dojo Agent Platform running on http://localhost:${info.port}`);
          resolve(server);
        });
        server.once('error', reject);
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'EADDRINUSE' || attempt >= BIND_MAX_ATTEMPTS) {
        logger.error(`Cannot bind port ${PORT}; exiting before any database work`, { error: e.message, code: e.code ?? null, attempts: attempt });
        process.exit(1);
      }
      logger.warn(`Port ${PORT} is in use, retrying in ${BIND_RETRY_MS}ms...`, { attempt, of: BIND_MAX_ATTEMPTS });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, BIND_RETRY_MS));
    }
  }
}

async function main(): Promise<void> {
  logger.info('Starting Dojo Agent Platform...');

  // Until the real app is built at the end of boot, every request gets the 503 starting answer.
  let appFetch: ((request: Request, env: unknown) => Response | Promise<Response>) | null = null;
  const server = await bindPortFirst((request, env) => (appFetch ? appFetch(request, env) : startingAnswer(request)));
  keepMacAwake();

  // Track in-flight responses so shutdown can close their connections (gateway/close-servers.ts).
  trackRequests(server as unknown as HttpServer);

  server.on('error', (err: NodeJS.ErrnoException) => {
    logger.error('Server error', { error: err.message, code: err.code ?? null });
    process.exit(1);
  });

  // System-dependency check (brew packages like whisper-cpp) in the background so it never blocks startup.
  void (async () => {
    try {
      const { ensureSystemDeps } = await import('./services/ensure-system-deps.js');
      await ensureSystemDeps();
    } catch (err) {
      logger.warn('System-deps check failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  // One-shot technique-dependency audit: messages the trainer once (config flag) to verify the files named
  // in TECHNIQUE.md and populate dependencies.json. Deferred so the trainer is initialized.
  setTimeout(() => {
    void (async () => {
      try {
        const { runTechniqueDependencyAuditOnce } = await import('./techniques/audit-migration.js');
        await runTechniqueDependencyAuditOnce();
      } catch (err) {
        logger.warn('Technique dependency audit dispatch failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // One-time notice: Google accounts on the pre-broker OAuth client need a reconnect (after migrations
      // and seeds).
      try {
        const { notifyGoogleReauthOnce } = await import('./google/reauth-notice.js');
        notifyGoogleReauthOnce();
      } catch (err) {
        logger.warn('Google re-auth notice dispatch failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }, 30_000);

  ensureDirectories();

  const fsFolds = probeFsCaseInsensitive(path.join(homeDir(), '.dojo', 'data'), fs);
  setFsCaseInsensitive(fsFolds);
  logger.info('Filesystem case sensitivity probed', { caseInsensitive: fsFolds });

  loadSecrets();

  // 2b. Refresh the bundled watchdog BEFORE migrations so it supervises a long first-boot migration.
  {
    try {
      const { refreshBundledWatchdog } = await import('./services/watchdog-refresh.js');
      const r = await refreshBundledWatchdog();
      if (r.refreshed) logger.info('Watchdog self-refresh: installed the bundled watchdog before migrations', { reason: r.reason });
    } catch (err) {
      logger.warn('Watchdog self-refresh failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // 3. Run database migrations
  // Boot sentinel: for a self-update boot, count the attempt BEFORE migrations (a crash mid-migration
  // still counts; the runner records the first commit). First settle an install cut off mid-swap.
  const migCountBefore = countAppliedMigrations();
  (await import('./update/install-tree.js')).settlePendingInstall(path.join(homeDir(), '.dojo'));
  // An updater predating the sentinel may swap the platform without a marker: migrations already applied
  // (a fresh install has 0) plus more pending means a real self-update, so synthesize the episode BEFORE
  // migrations.
  if (!recordBootAttempt() && migCountBefore > 0 && countAvailableMigrationFiles() > migCountBefore) {
    const { getCurrentVersion } = await import('./gateway/routes/update.js');
    synthesizeMigrationBootEpisode(getCurrentVersion());
    logger.warn('D-F: self-update boot detected without an updater marker (old-updater jump); synthesized a boot episode so the watchdog stays patient through the migration window');
  }
  runMigrations();

  // 3b. One-shot crash cleanup: agents left 'working', dangling model pointers. After the port bind (a
  // duplicate instance must not rewrite the running box's rows) and after the migrations that create the
  // table.
  try {
    const { runStartupRecoverySweep } = await import('./agent/runtime.js');
    runStartupRecoverySweep();
  } catch (err) {
    logger.warn('Startup recovery sweep failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
  }

  // 3a-. Declare every agent's effective access (the snapshot `getAccessGrants` already answers with, so
  // no verdict changes). Idempotent; before the service ensures below so they see rows that carry grants.
  try {
    const { materializeAccessGrants } = await import('./agent/access/materialize.js');
    materializeAccessGrants();
  } catch (err) {
    logger.warn('Access-grant materialization failed (non-fatal; agents keep answering from the snapshot)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  await (await import('./prompt/shipped-souls.js')).refreshShippedSoulsAtBoot();

  // 3a-c. One time: an upgraded box keeps its owner (services/owner-star-upgrade.ts).
  await (await import('./services/owner-star-upgrade.js')).starTheOwnersAtBoot();

  try {
    await (await import('./agent/main-model-floor.js')).moveAgentsOffSmallModels();   // an agent on a too-small model is moved, the owner told once
  } catch (err) {
    logger.warn('Moving agents off a too-small model failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
  }

  try {
    const { seedGoogleAccountsFromConfig } = await import('./google/accounts.js');
    seedGoogleAccountsFromConfig();
    const { seedMicrosoftAccountsFromConfig } = await import('./microsoft/accounts.js');
    seedMicrosoftAccountsFromConfig();
  } catch (err) {
    logger.warn('Workspace account seed failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 3a0b. Seal any Workspace OAuth token still stored in the clear, AFTER the seed. Never throws.
  const { sealWorkspaceTokensAtRest } = await import('./credentials/seal-existing.js');
  await sealWorkspaceTokensAtRest();

  try {
    const { loadSavedChecks } = await import('./migration/checks.js');
    loadSavedChecks();
  } catch { /* ignore, migration module may not exist yet */ }

  // 3b. Generate tool docs for load_tool_docs; the generator records doc freshness (tools/doc-freshness.ts).
  try {
    const { generateToolDocs } = await import('./tools/index-generator.js');
    await generateToolDocs();
  } catch (err) {
    // A throw means the generator never reached its own recorder, so record the failure here.
    const { recordToolDocsFailure } = await import('./tools/doc-freshness.js');
    const { getToolsDir } = await import('./tools/tool-doc-read.js');
    recordToolDocsFailure(getToolsDir(), err);
  }

  ensurePrimaryAgent();

  try {
    const { ensureSystemGroup } = await import('./agent/groups.js');
    ensureSystemGroup();
  } catch { /* groups table may not exist yet on first boot */ }

  {
    const repaired = resetWorkingAgentsToIdleAtBoot();
    if (repaired > 0) {
      logger.info(`Reset ${repaired} agent(s) from 'working' to 'idle' after restart`);
    }
  }

  try {
    const { sweepBootStaleness } = await import('./work/work-reaper.js');
    sweepBootStaleness();
  } catch (err) {
    logger.warn('Boot staleness sweep failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
  }

  // 4b1. Boot crash-reconciliation. A kill after the pickup claimed a human ask but before the reply was
  // produced leaves the ask reading SERVED forever. Recorded facts decide: did the claiming turn finish
  // (`turns.ended_at`), did it act (`turns.effectful_calls`, effects named from its tool rows)? Died and
  // did nothing: hand the ask back. Died but acted: hand it back naming those effects (no duplicates).
  // Killed between send and close: the ask was answered at `claimed`, so close it pointing at that
  // delivery. No age window: the hand-back carries the real age.
  {
    reapToolboxGroupsAtBoot();   // a hard kill left no exit hook to end what agents backgrounded
    // A command handed to the background was ended by this restart; its agent is told on its next turn.
    void import('./agent/background-commands.js').then((m) => m.tellAgentsOfCommandsCutByRestart()).catch(() => { /* best effort */ });
    // Asks that can never be served or closed (no conversation identity, or a root message that is gone)
    // get a terminal state instead of sitting `open` forever. BEFORE the hand-back below.
    try {
      const { abandoned } = abandonUnservableAsks();
      if (abandoned > 0) {
        logger.warn(`Boot: abandoned ${abandoned} ask ticket(s) that could never be served or closed (no conversation identity, or the message they were FOR is gone)`);
      }
    } catch (err) {
      logger.warn('Boot unservable-ask sweep failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
    }
    try {
      const { releaseStepOwed } = await import('./release/release-steps.js');   // the version boundary
      const { reArmed, closed } = reconcileOrphanedClaims({ inheritedBacklog: releaseStepOwed('orphaned-ask-backlog') });
      if (reArmed > 0 || closed > 0) {
        logger.warn(`Boot crash-reconciliation: closed ${closed} ask(s) whose claiming turn had already DELIVERED (the answered-by edge, never string inference); handed ${reArmed} orphaned ask(s) back for the re-drain, each carrying its age and any effects the dead turn already made for the turn that serves it (tracker untouched)`);
      }
    } catch (err) {
      logger.warn('Boot crash-reconciliation failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
    }
    // Every boot: an ask left claimed by a turn that ended is settled again; one whose reply is still queued waits.
    try {
      const { healStuckClaims } = await import('./work/ask-remediation.js');
      const { counts } = healStuckClaims();
      if (counts.candidates > 0) logger.warn('Boot: asks left claimed by an ended turn were settled again', counts);
    } catch (err) {
      logger.warn('Boot ask heal failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
    }
    // 4b1c. One-shot ask-ledger remediation (a `config` row disarms it). Position is load-bearing: AFTER
    // the staleness sweep (its handed-back rows are never met by the reboot-swarm guard) and BEFORE the
    // re-drain below (the same boot that hands an ask back serves it).
    try {
      const { runArmedAskRemediation } = await import('./work/ask-remediation.js');
      const remediation = runArmedAskRemediation();
      if (remediation) {
        logger.warn(
          'Boot: ask-ledger remediation ran (SWEEP-A TB3) — '
          + `stuck-claimed ${remediation.stuckClaimed.candidates} (closed ${remediation.stuckClaimed.closed}, held ${remediation.stuckClaimed.held}, handed back ${remediation.stuckClaimed.reopened}); `
          + `answered-then-abandoned corrected ${remediation.answeredThenAbandoned.corrected}; `
          + `compile-pending flags cleared ${remediation.compilePendingOrphans.cleared}/${remediation.compilePendingOrphans.candidates}; `
          + `chip receipts ${remediation.chipReceipts.candidates} (re-pointed ${remediation.chipReceipts.repointed}, handed back ${remediation.chipReceipts.reopened}, ambiguous ${remediation.chipReceipts.handedUp}). `
          + `${remediation.reopenedIds.length} ask(s) are owed again and the re-drain below is what serves them.`,
        );
      }
    } catch (err) {
      logger.warn('Boot ask-ledger remediation failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // 4b2. Re-drain unanswered conversations after restart: an inbound persisted with conv_key NULL lost its
  // in-memory wakeup and nothing else re-reads it. handleMessage('') re-reads the DB and normal serving
  // takes over; it is idempotent, and sends are staggered so a fleet of agents does not fire at once.
  try {
    const db = getDb();
    const { getWaitingHumanConversations, getPendingEngineEvent } = await import('./agent/v2/counterparty.js');
    const { findUnrepliedAssignForAgent } = await import('./agent/a2a-replies.js');
    const { getAgentRuntime } = await import('./agent/runtime.js');
    // Exclude terminated agents: findUnrepliedAssignForAgent has no status filter.
    const agentRows = db.prepare("SELECT id FROM agents WHERE status != 'terminated'").all() as Array<{ id: string }>;
    let redrained = 0;
    for (const { id } of agentRows) {
      try {
        // One kick covers an unanswered human conversation AND an unreplied A2A ASSIGN/QUESTION.
        const owesHuman = getWaitingHumanConversations(id).length > 0;
        // Only an A2A assign from the last 30 minutes is re-drained: older ones are stale backlog (matches
        // the sweep in 4b1), and stale human rows were already stamped out of the waiting set there.
        const owesA2A = !owesHuman && findUnrepliedAssignForAgent(id, 20, 30) !== null;
        // Also a pending-eligible engine event (a reminder mid-delivery at restart): getPendingEngineEvent
        // gates on its lifecycle (unclaimed, unswept, attempts < 5, backoff passed, within the 6-hour
        // expiry) and expires exhausted ones.
        const owesEngine = !owesHuman && !owesA2A && getPendingEngineEvent(id) !== null;
        if (owesHuman || owesA2A || owesEngine) {
          redrained++;
          const delay = redrained * 300;
          setTimeout(() => {
            try { void getAgentRuntime().handleMessage(id, '').catch(() => { /* best effort */ }); }
            catch { /* best effort */ }
          }, delay);
        }
      } catch { /* per-agent best effort */ }
    }
    if (redrained > 0) {
      logger.info(`Boot re-drain: kicked ${redrained} agent(s) with unanswered conversations after restart`);
    }
  } catch (err) {
    logger.warn('Boot re-drain failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
  }

  // 4b3. Boot re-drain of delegated owner questions (fail-closed backstop). resolveJoinsAtBoot lands a
  // reply that already arrived and fails closed (owner notice) when the asked agent is terminated or the
  // join is past its ttl_at; fresh joins are left to the reaper. It only relays or settles rows, never
  // wakes an agent. Delayed so the channel bridges are up (a down bridge falls back to the dashboard).
  setTimeout(() => {
    void (async () => {
      try {
        const { resolveJoinsAtBoot } = await import('./agent/a2a-transport.js');
        const r = await resolveJoinsAtBoot();
        if (r.relayedReplies > 0 || r.failedClosed > 0 || r.leftOpen > 0) {
          logger.info(`Boot join re-drain: relayed ${r.relayedReplies} stranded repl(ies), failed ${r.failedClosed} join(s) closed, left ${r.leftOpen} open for the TTL reaper`);
        }
      } catch (err) {
        logger.warn('Boot join re-drain failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  }, 20_000);

  {
    const { isSetupCompleted } = await import('./config/platform.js');
    if (isSetupCompleted()) {
      try {
        const { ensurePMAgentRunning } = await import('./tracker/pm-agent.js');
        ensurePMAgentRunning();
        logger.info('PM agent ensured on server startup');
      } catch (err) {
        logger.error('Failed to ensure PM agent', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // 4c1. Start the scheduler clock (independent of the project manager), gated on setup completion.
  {
    const { isSetupCompleted: isSetupDone } = await import('./config/platform.js');
    if (isSetupDone()) {
      try {
        const { startScheduler } = await import('./scheduler/clock.js');
        startScheduler();
      } catch (err) {
        logger.error('Failed to start the scheduler clock', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  {
    const { isSetupCompleted: isSetupDone } = await import('./config/platform.js');
    if (isSetupDone()) {
      try {
        const { ensureTrainerAgentRunning } = await import('./techniques/trainer-agent.js');
        ensureTrainerAgentRunning();
        logger.info('Trainer agent ensured on server startup');
      } catch (err) {
        logger.error('Failed to ensure Trainer agent', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }


  {
    const { isSetupCompleted: isSetupDone } = await import('./config/platform.js');
    if (isSetupDone()) {
      try {
        const { ensureHealerAgentRunning } = await import('./healer/healer-agent.js');
        ensureHealerAgentRunning();
        logger.info('Healer agent ensured on server startup');
      } catch (err) {
        logger.error('Failed to ensure Healer agent', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // 4c6. Router background task (embedder keep-warm); a no-op unless an agent uses auto.
  {
    const { isSetupCompleted: isSetupDone } = await import('./config/platform.js');
    if (isSetupDone()) {
      try {
        const { startEmbedderWarmer } = await import('./router/semantic.js');
        startEmbedderWarmer();
        logger.info('Router background task started');
      } catch (err) {
        logger.warn('Failed to start router background tasks', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  {
    const { isSetupCompleted: isSetupDone } = await import('./config/platform.js');
    if (isSetupDone()) {
      try {
        const { ensureDreamerAgentRunning } = await import('./vault/maintenance.js');
        ensureDreamerAgentRunning();
        logger.info('Dreamer agent ensured on server startup');
      } catch (err) {
        logger.error('Failed to ensure Dreamer agent', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Purge service-agent archives still in the backlog (idempotent; a no-op once clean).
      try {
        const { purgeServiceAgentArchives } = await import('./vault/archive.js');
        purgeServiceAgentArchives();
      } catch (err) {
        logger.warn('Service-agent archive purge failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // One-shot scan of timezone workarounds for a dropped `anchor_time`; never rewrites a schedule.
      const { runAnchorCompensationPass } = await import('./scheduler/anchor-compensation.js');
      runAnchorCompensationPass();

      // Per-release boot steps: the gap from the last-run version decides which run; every step is
      // idempotent, so a lost marker costs a wasted pass, never a double repair (release/release-steps.ts).
      // Awaited so the first step's line is waiting for the primary's first turn.
      try {
        const { runReleaseSteps } = await import('./release/release-steps.js');
        const steps = await runReleaseSteps();
        logger.info('Release steps pass complete', { from: steps.from, to: steps.to, ran: steps.ran, failed: steps.failed });
      } catch (err) {
        logger.warn('Release steps pass failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  {
    const db = getDb();
    const imEnabled = db.prepare("SELECT value FROM config WHERE key = 'imessage_enabled'").get() as { value: string } | undefined;
    const imRecipient = db.prepare("SELECT value FROM config WHERE key = 'imessage_recipient'").get() as { value: string } | undefined;
    logger.info('iMessage bridge startup gate', {
      imEnabled: imEnabled?.value ?? '<missing>',
      hasRecipient: !!imRecipient?.value,
      willStart: imEnabled?.value === 'true' && !!imRecipient?.value,
    });
    if (imEnabled?.value === 'true' && imRecipient?.value) {
      try {
        const { startIMBridge } = await import('./services/imessage-bridge.js');
        startIMBridge(imRecipient.value);
        logger.info('iMessage bridge started');
      } catch (err) {
        logger.error('Failed to start iMessage bridge', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Replies left waiting by the last run go out once the bridge is up.
    const { armSenderTimer } = await import('./agent/v2/channel-sender.js');
    armSenderTimer();
  }

  {
    try {
      // Lists saved under a slot name move to their mailbox before the first poll reads them.
      try { (await import('./services/channel-safe-senders.js')).moveSlotListsToMailboxes(); } catch { /* retried next start */ }
      const { startGmailWatcher } = await import('./services/gmail-watcher.js');
      startGmailWatcher();
    } catch (err) {
      logger.warn('Gmail watcher failed to start', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  {
    try {
      const { startOutlookWatcher } = await import('./services/outlook-watcher.js');
      startOutlookWatcher();
    } catch (err) {
      logger.warn('Outlook watcher failed to start', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  {
    try {
      const { startTeamsWatcher } = await import('./services/teams-watcher.js');
      startTeamsWatcher();
    } catch (err) {
      logger.warn('Teams watcher failed to start', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 4i-1. Workspace reconnect probe: every ~30 min re-tests benched (connected=0) Google/Microsoft
  // accounts that hold a refresh token and un-benches those that work. No network work unless something is
  // benched.
  {
    try {
      const { startWorkspaceReconnectProbe } = await import('./services/workspace-reconnect-probe.js');
      startWorkspaceReconnectProbe();
    } catch (err) {
      logger.warn('Workspace reconnect probe failed to start', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 4i-2. Daily update checker: refreshes a DB cache of the latest release (model-free) that
  // check_for_update reads on demand.
  {
    try {
      const { startUpdateChecker } = await import('./services/update-checker.js');
      startUpdateChecker();
    } catch (err) {
      logger.warn('Update checker failed to start', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 4i-3. Sweep a killed update's leftovers, then prune old platform backups and set-aside failed builds
  // (the post-update prune can be cut short by the restart's process.exit). Never blocks boot.
  {
    void (async () => {
      try {
        const { pruneOldBackupsAsyncAtBoot } = await import('./gateway/routes/update.js');
        await pruneOldBackupsAsyncAtBoot();
      } catch (err) {
        logger.warn('Boot-time backup prune failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }

  // 4j. Backfill model capabilities for models with an empty array, in the background (the fetches are
  // slow).
  {
    void (async () => {
      try {
        const { backfillEmptyCapabilities } = await import('./services/capabilities.js');
        await backfillEmptyCapabilities();
        // Seed generation parameter specs for video models once capabilities exist (no-op if a spec exists).
        const { backfillGenerationParams } = await import('./services/generation-params.js');
        backfillGenerationParams();
        // Seed TTS voice catalogs for audio-generation models (no-op if one exists or there is no family
        // seed).
        const { backfillVoiceCatalog } = await import('./services/voice-catalog.js');
        backfillVoiceCatalog();
        // A newly probed model may be vision-capable now; the startup call below covers populated
        // capabilities.
        const { autoConfigureFallbackVisionModelIfObvious } = await import('./services/vision-model.js');
        autoConfigureFallbackVisionModelIfObvious();
      } catch (err) {
        logger.warn('Capability backfill failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }

  // 4j. Ollama upkeep (current version, model limit, standard models) and RAM-aware num_ctx recommendations.
  {
    void (async () => {
      try {
        void import('./agent/decision-ask.js').catch((err) => logger.error('the decision seam could not be installed; every judgment stays with its rule', { error: err instanceof Error ? err.message : String(err) })); void import('./services/ollama-upkeep.js').then((m) => m.upkeep('boot')).catch((err) => logger.warn('the Ollama upkeep did not run at boot', { error: err instanceof Error ? err.message : String(err) }));   // a download must not hold the backfill
        const { backfillRecommendedNumCtx } = await import('./services/num-ctx-calculator.js');
        await backfillRecommendedNumCtx();
      } catch (err) {
        logger.warn('num_ctx backfill failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }

  // 4j-bis. Mirror the safe-sender lists (all channels) into the contacts store so every trusted sender
  // resolves by name. Idempotent, additive and fast, so inline (see backfillSafeSenderContacts for the
  // dropped-flag tradeoff).
  try {
    const { backfillSafeSenderContacts } = await import('./services/channel-safe-senders.js');
    const r = backfillSafeSenderContacts();
    if (r.created || r.updated) {
      logger.info('Safe-sender contacts reconcile complete', { created: r.created, updated: r.updated });
    }
  } catch (err) {
    logger.warn('Safe-sender contacts reconcile failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 4k. Refresh model pricing in the background from providers whose API exposes it (mainly OpenRouter);
  // prices the API omits keep their stored values.
  {
    void (async () => {
      try {
        const { syncAllProviderPricing } = await import('./services/pricing-sync.js');
        await syncAllProviderPricing();
      } catch (err) {
        logger.warn('Pricing sync failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }

  // 4l. Refresh Anthropic/OpenAI/DeepSeek pricing from the LiteLLM price index; status persists in config.
  {
    void (async () => {
      try {
        const { syncLitellmPricing } = await import('./services/litellm-pricing-sync.js');
        await syncLitellmPricing();
      } catch (err) {
        logger.warn('LiteLLM pricing sync failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }

  // 4m-0. Close media job rows nobody owns: failed with a reason, never deleted (services/job-orphans.ts).
  // BEFORE the video resume below: only here can no row belong to a process in THIS one. The notice rides
  // along because a closed row cannot announce itself.
  {
    try {
      const { reconcileOrphanedJobsAtBoot } = await import('./services/job-orphans.js');
      const { notifyAbandonedGenerationJobs } = await import('./services/generation-jobs.js');
      const abandoned = reconcileOrphanedJobsAtBoot();
      notifyAbandonedGenerationJobs(abandoned.filter((j) => j.table === 'generation_jobs'));
    } catch (err) {
      logger.warn('Abandoned media job reconciliation failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 4m-1. Resume in-flight video jobs: the poller drives every 'queued'/'polling' row to delivery.
  // 4m-0 leaves these rows to the provider's render.
  {
    try {
      const { startVideoJobPoller } = await import('./services/video-job-poller.js');
      startVideoJobPoller();
    } catch (err) {
      logger.warn('Video job poller failed to start', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  setLogBroadcast((entry) => {
    broadcast({ type: 'log:entry', entry });
  });

  // 6. Boot is done: hand the already-listening socket its real handler (it answered 503 until now).
  const { app, injectWebSocket, wss } = createServer();
  appFetch = app.fetch;
  injectWebSocket(server);
  logger.info('Dojo Agent Platform is serving');

  // The server is listening: for a self-update boot, arm the ~90s timer that flips the marker to healthy.
  scheduleUpdateHealthConfirm();

  const { removeAbandonedPartFiles } = await import('./gateway/routes/upload.js');
  setInterval(removeAbandonedPartFiles, 24 * 60 * 60 * 1000);
  const { runDailyDatabaseUpkeep } = await import('./db/daily-upkeep.js');
  setInterval(() => { void runDailyDatabaseUpkeep(); }, 24 * 60 * 60 * 1000);

  // Warm the reader pool now so no user's first search pays the spawn; best-effort, since a box without
  // worker threads runs searches on the serving thread.
  void warmReaderPool();

  // FTS health check: never boot-blocking, because scheduleFtsHealthCheck returns immediately and touches
  // no database; the repair runs on its own thread and search uses the bounded fallback until it finishes.
  scheduleFtsHealthCheck();
  removeAbandonedPartFiles(); // Run once on startup
  void runDailyDatabaseUpkeep();

  setTimeout(async () => {
    try {
      const { autoStartTunnel } = await import('./services/tunnel.js');
      autoStartTunnel(PORT);
    } catch (err) {
      logger.warn('Failed to auto-start tunnel', { error: err instanceof Error ? err.message : String(err) });
    }
  }, 3000);

  try {
    (await import('./vault/maintenance.js')).scheduleDreamingCycle();
    (await import('./memory/legacy-rebuild-boot.js')).scheduleLegacyRebuildAtBoot();   // the memory start: waiting writers asked again, the older-notes rebuild once
  } catch (err) {
    logger.warn('Failed to schedule dreaming cycle or the older-notes rebuild', { error: err instanceof Error ? err.message : String(err) });
  }

  // Schedule the incremental embedding-backfill drain: channel inbound is persisted at many sites and none
  // embed at write. runBackfill touches only rows missing an embedding and guards against overlapping
  // runs; the first pass is delayed so boot is not slowed.
  const scheduleEmbeddingBackfill = async () => {
    try {
      const { runBackfill, isBackfillRunning } = await import('./memory/backfill.js');
      if (isBackfillRunning()) return;
      await runBackfill();
    } catch (err) {
      logger.debug('scheduled embedding backfill drain failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  setTimeout(() => { void scheduleEmbeddingBackfill(); }, 60_000);
  setInterval(() => { void scheduleEmbeddingBackfill(); }, 10 * 60_000);

  // Delegated-question TTL expiry is `REAPER_KINDS['join-ttl']` in `work/work-reaper.ts`, not a timer here.

  // One-time re-embed of vault entries with a NULL embedding (they match only an exact LIKE); delayed,
  // best-effort.
  setTimeout(() => {
    void (async () => {
      try {
        const { reembedNullVaultEntries } = await import('./vault/embedding-refresh.js');
        await reembedNullVaultEntries();
      } catch (err) {
        logger.debug('reembedNullVaultEntries failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }, 90_000);

  // One-shot: if exactly one enabled vision-capable model exists and no fallback is configured, set it as
  // the fallback; multi-vision installs stay unset so Settings -> Models can prompt for a choice.
  try {
    const { autoConfigureFallbackVisionModelIfObvious } = await import('./services/vision-model.js');
    autoConfigureFallbackVisionModelIfObvious();
  } catch (err) {
    logger.warn('autoConfigureFallbackVisionModelIfObvious failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Engine-paused recurring tasks are released once as data by a migration, not scanned for on every boot.

  try {
    const { scheduleHealingCycle, startHealerSelfWatchdog } = await import('./healer/healer-agent.js');
    scheduleHealingCycle();
    // Engine-level safety net so the Healer cannot get permanently stuck (every 5 min).
    startHealerSelfWatchdog();
    // Frequent auto-fix sweep that recovers stuck/paused/errored agents past their cooldown.
    const { startFrequentAutoFixes } = await import('./healer/auto-fix.js');
    startFrequentAutoFixes();
    logger.info('Healer cycle scheduled + self-watchdog + frequent auto-fix started');
  } catch (err) {
    logger.warn('Failed to schedule healing cycle', { error: err instanceof Error ? err.message : String(err) });
  }

  // Injury recovery is event-driven (runtime.ts calls onAgentInjured() when an agent enters 'error');
  // rehydrate the agents injured before a restart, since the grace-period timers are in-memory.
  try {
    const { rehydrateInjuredAgents } = await import('./healer/injury-recovery.js');
    rehydrateInjuredAgents();
  } catch (err) {
    logger.warn('Failed to rehydrate injured agents', { error: err instanceof Error ? err.message : String(err) });
  }

  // The destructive-approval boot sweep is the reaper's first tick: runReaperTick() runs every obligation
  // sweep once.
  try {
    const { runReaperTick } = await import('./work/work-reaper.js');
    const first = await runReaperTick();
    logger.info('Reaper boot pass complete', { ran: first.ran, failed: first.failed });
  } catch (err) {
    logger.warn('Reaper boot pass failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
  }

  // Spawn timeout timers are in-memory: rebuild them from agents.timeout_at so a pending decision survives
  // a reboot.
  try { reArmSpawnTimeouts(); } catch (err) {
    logger.warn('Spawn timeout boot re-arm failed', { error: err instanceof Error ? err.message : String(err) });
  }

  // startReaper installs the single 30-second tick for every obligation sweep (work/work-reaper.ts). This
  // interval keeps only checkTimeouts, the spawn decision timer (an agent-lifecycle deadline, not an
  // obligation sweep).
  const { startReaper } = await import('./work/work-reaper.js');
  startReaper();

  const timeoutInterval = setInterval(() => {
    try { checkTimeouts(); } catch (err) {
      logger.error('Timeout checker failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }, 30_000);

  let shuttingDown = false;
  const shutdown = (): void => {
    // A second SIGTERM/SIGINT must not run the whole sequence again (second close, second closeDb).
    if (shuttingDown) { logger.info('Shutdown already in progress'); return; }
    shuttingDown = true;
    logger.info('Shutting down...');
    clearInterval(timeoutInterval);
    // STEP 1: stop the work clocks first: during server.close's wait for connections the reaper and
    // scheduler would keep waking agents and writing rows. Each stop is idempotent and guarded.
    stopBackgroundClocks();
    // STEP 2: stop the worker threads: process.exit() joins a worker and nothing preempts a native sqlite
    // call, so an FTS rebuild would hang the exit until SIGKILL. stopFtsRepair stops at the next chunk
    // boundary; both no-op when idle.
    if (stopFtsRepair()) logger.info('asked the background FTS repair to stop; it will be redone on the next boot');
    void terminateReaderPool();
    // Tell the video poll loops (up to thirty minutes, mostly asleep) to stand down BEFORE closeDb, so
    // none wakes on a closed handle. Rows stay open and the next boot's resume adopts them.
    import('./services/video-poller-lifetime.js').then(m => m.stopVideoJobPoller()).catch(() => {});
    import('./services/tunnel.js').then(m => m.stopTunnel()).catch(() => {});
    import('./voice/stt-service.js').then(m => m.stopWhisperServer()).catch(() => {});   // its child would outlive this process
    // STEP 3: close the gateway so server.close() can finish: the ws server owns its clients and an
    // upgraded socket keeps the http server open, which would stall until the supervisor SIGKILLs before
    // closeDb (gateway/close-servers.ts). `serve()` is always HTTP/1 here, so the cast is sound.
    // process.exit(0) is reached on EVERY path.
    void closeServers(server as unknown as HttpServer, wss)
      .catch((err) => {
        logger.error('Closing the gateway failed during shutdown', { error: err instanceof Error ? err.message : String(err) });
      })
      .then(async () => {
        try {
          const { closeDb } = await import('./db/connection.js');
          closeDb();
        } catch (err) {
          logger.error('Closing the database failed during shutdown', { error: err instanceof Error ? err.message : String(err) });
        }
        logger.info('Shutdown complete');
      })
      .catch(() => {})
      .finally(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  // Plain text to stderr too: launchd writes it to ~/.dojo/logs/platform.stderr.log, the readable copy.
  process.stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n\n`);
  logger.error('Fatal startup error', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
