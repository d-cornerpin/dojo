import { serve } from '@hono/node-server';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { createLogger, setLogBroadcast } from './logger.js';
import { getDb } from './db/connection.js';
import { runMigrations } from './db/migrations.js';
import { loadSecrets } from './config/loader.js';
import { createServer } from './gateway/server.js';
import { broadcast } from './gateway/ws.js';
import { checkTimeouts } from './agent/spawner.js';
import { getPrimaryAgentId, getPrimaryAgentName, getPMAgentId, isPMEnabled } from './config/platform.js';

const logger = createLogger('main');
const PORT = parseInt(process.env.DOJO_PORT ?? '3001', 10);

// Surface uncaught crashes to the structured log instead of silently
// exiting. Without this, a throw inside a third-party WebSocket event
// listener (Hume SDK, the gateway WS) takes down the process leaving
// only an opaque stderr dump. We still exit so dev-mode (tsx watch)
// restarts cleanly — just leave a breadcrumb first.
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — process will exit', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  setTimeout(() => process.exit(1), 100);
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

const PLATFORM_DIRS = [
  path.join(os.homedir(), '.dojo'),
  path.join(os.homedir(), '.dojo', 'data'),
  path.join(os.homedir(), '.dojo', 'logs'),
  path.join(os.homedir(), '.dojo', 'prompts'),
  path.join(os.homedir(), '.dojo', 'uploads'),
  path.join(os.homedir(), '.dojo', 'uploads', 'generated'),
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

  // Skip if setup hasn't been completed — OOBE will provision the agent
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

  const enabledModel = db.prepare(
    "SELECT id FROM models WHERE is_enabled = 1 ORDER BY name ASC LIMIT 1"
  ).get() as { id: string } | undefined;

  db.prepare(`
    INSERT INTO agents (id, name, model_id, system_prompt_path, status, config, created_by,
                        classification, created_at, updated_at)
    VALUES (?, ?, ?, NULL, 'idle', '{"shareUserProfile":true}', 'system', 'sensei', datetime('now'), datetime('now'))
  `).run(
    primaryId,
    primaryName,
    enabledModel?.id ?? null,
  );

  logger.info('Created primary agent', { id: primaryId, name: primaryName, modelId: enabledModel?.id ?? 'none' });
}

async function main(): Promise<void> {
  logger.info('Starting Dojo Agent Platform...');

  // System-dependency check (brew packages like whisper-cpp). Runs in the
  // background — we don't block server startup on a `brew install` that
  // could take 30+ seconds. By the time the install completes and the
  // toast broadcasts, the dashboard has reconnected to the restarted
  // server and the user sees the "whisper-cpp installed" notification.
  // Idempotent: a no-op when all deps are already present (~200ms).
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

  // One-shot technique-dependency audit. The first server boot after
  // this feature ships drops a message in the trainer's chat asking
  // them to walk every existing technique and (a) verify every file
  // referenced in TECHNIQUE.md is in the support dir, (b) populate
  // dependencies.json. Persists a config flag once dispatched so we
  // only ever message the trainer once. Deferred well past server
  // boot to give the trainer agent time to fully initialize.
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
      // One-time post-update notice: if Google accounts were connected under the
      // pre-broker OAuth client, they need a reconnect. Runs after migrations,
      // the Google-account seed, and the primary agent are all ready (all done
      // synchronously in main() well before this deferred block fires).
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

  // 1. Create required directories
  ensureDirectories();

  // 2. Load secrets
  loadSecrets();

  // 3. Run database migrations
  runMigrations();

  // 3a0. Seed Workspace account rows from legacy per-key config (Path B,
  //      layer 1). Idempotent: only copies existing gws_*/gws_user_* into
  //      position-1 rows once; leaves the legacy keys in place.
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

  // 3a. Load saved migration checks (if any from a recent import)
  try {
    const { loadSavedChecks } = await import('./migration/checks.js');
    loadSavedChecks();
  } catch { /* ignore — migration module may not exist yet */ }

  // 3b. Generate tool documentation files for load_tool_docs
  try {
    const { generateToolDocs } = await import('./tools/index-generator.js');
    const result = await generateToolDocs();
    logger.info('Tool docs generated', { count: result.count });
  } catch (err) {
    logger.warn('Tool docs generation failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 4. Ensure primary agent exists (skips if OOBE hasn't completed yet)
  ensurePrimaryAgent();

  // 4a. Ensure system group exists and permanent agents are assigned
  try {
    const { ensureSystemGroup } = await import('./agent/groups.js');
    ensureSystemGroup();
  } catch { /* groups table may not exist yet on first boot */ }

  // 4b. Reset stuck agents
  {
    const db = getDb();
    const stuck = db.prepare("UPDATE agents SET status = 'idle' WHERE status = 'working'").run();
    if (stuck.changes > 0) {
      logger.info(`Reset ${stuck.changes} agent(s) from 'working' to 'idle' after restart`);
    }
  }

  // 4b2. Re-drain unanswered conversations after restart (comms-audit D-1).
  // An inbound that arrived before a restart is durably persisted with conv_key
  // NULL (unanswered), but the in-memory wakeup that would trigger its turn is
  // lost on restart — so it would sit unanswered until the NEXT inbound happens
  // to poke the runtime. Nothing else re-reads it: the waiting SET is durable,
  // the TRIGGER to read it was not. Sweep every agent for waiting human
  // conversations and kick a drain, so a message the user sent is never silently
  // forgotten across a restart (invariant 2 — never forgets to answer).
  // handleMessage('') re-reads the DB and the normal serving path takes over;
  // it is idempotent (an already-served row has a conv_key and is skipped), and
  // sends are staggered so a fleet of agents doesn't fire all at once.
  try {
    const db = getDb();
    const { getWaitingHumanConversations } = await import('./agent/v2/counterparty.js');
    const { findUnrepliedAssignForAgent } = await import('./agent/a2a-replies.js');
    const { getAgentRuntime } = await import('./agent/runtime.js');
    // C20: exclude terminated agents — the re-drain must never resurrect a dead agent.
    // findUnrepliedAssignForAgent has no status filter, so a terminated agent with an
    // unreplied A2A ASSIGN would otherwise be kicked, run a turn (status flipped to
    // 'working'), and emit a zombie A2A reply.
    const agentRows = db.prepare("SELECT id FROM agents WHERE status != 'terminated'").all() as Array<{ id: string }>;
    let redrained = 0;
    for (const { id } of agentRows) {
      try {
        // T-3 (comms-audit): re-drain BOTH unanswered human conversations AND an
        // unreplied A2A ASSIGN/QUESTION. The earlier D-1 swept only human
        // conversations, so an inter-agent request that arrived just before a
        // restart was lost forever (its wakeup was in-memory; nothing re-reads it
        // and findUnrepliedAssignForAgent only runs inside a turn). One kick covers
        // both — runV2Turn re-classifies and serves whichever is owed.
        const owesHuman = getWaitingHumanConversations(id).length > 0;
        const owesA2A = !owesHuman && findUnrepliedAssignForAgent(id) !== null;
        if (owesHuman || owesA2A) {
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

  // 4c. Ensure PM agent exists and poke loop is running (if enabled and setup is complete)
  {
    const { isSetupCompleted } = await import('./config/platform.js');
    if (isSetupCompleted() && isPMEnabled()) {
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

  // 4c2. Ensure Trainer agent exists (if enabled and setup is complete)
  {
    const { isTrainerEnabled, isSetupCompleted: isSetupDone } = await import('./config/platform.js');
    if (isSetupDone() && isTrainerEnabled()) {
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

  // v2.10.3 — Imaginer agent retired. Image generation is now a
  // platform-config model picker (Settings → Dojo → Image Generation
  // Model) and the `image_create` tool calls that model directly.
  // Migration 059 terminates the legacy Imaginer agent row. This
  // step intentionally left empty for the gap.
  // 4c3. (Removed — Imaginer agent no longer auto-spawned)

  // 4c4. Ensure Healer agent exists (permanent resident)
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

  // 4c6. Router background tasks: embedder keep-warm + the sparse self-training
  //      maintenance loop. Both internally gate on an agent actually being on
  //      auto-router (see router/gating.ts), so they are cheap no-ops otherwise.
  {
    const { isSetupCompleted: isSetupDone } = await import('./config/platform.js');
    if (isSetupDone()) {
      try {
        const { startEmbedderWarmer } = await import('./router/semantic.js');
        startEmbedderWarmer();
        const { startRouterMaintenance } = await import('./router/maintenance.js');
        startRouterMaintenance();
        logger.info('Router background tasks started');
      } catch (err) {
        logger.warn('Failed to start router background tasks', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // 4c5. Ensure Dreamer agent exists (permanent resident)
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

      // One-shot purge of service-agent archives still sitting in the
      // backlog from before service agents were excluded from archiving.
      // Idempotent — runs on every boot but is a no-op once clean.
      try {
        const { purgeServiceAgentArchives } = await import('./vault/archive.js');
        purgeServiceAgentArchives();
      } catch (err) {
        logger.warn('Service-agent archive purge failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // 4d. Start iMessage bridge if enabled
  {
    const db = getDb();
    const imEnabled = db.prepare("SELECT value FROM config WHERE key = 'imessage_enabled'").get() as { value: string } | undefined;
    const imRecipient = db.prepare("SELECT value FROM config WHERE key = 'imessage_recipient'").get() as { value: string } | undefined;
    logger.info('iMessage bridge startup gate', {
      imEnabled: imEnabled?.value ?? '<missing>',
      imRecipient: imRecipient?.value ?? '<missing>',
      willStart: imEnabled?.value === 'true' && !!imRecipient?.value,
    });
    if (imEnabled?.value === 'true' && imRecipient?.value) {
      try {
        const { startIMBridge } = await import('./services/imessage-bridge.js');
        startIMBridge(imRecipient.value);
        logger.info('iMessage bridge started', { recipient: imRecipient.value });
      } catch (err) {
        logger.error('Failed to start iMessage bridge', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // 4e. Check Google Workspace CLI status on startup
  {
    try {
      const { checkGoogleOnStartup } = await import('./google/auth.js');
      await checkGoogleOnStartup();
    } catch (err) {
      logger.warn('Google Workspace startup check failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 4f. Check Microsoft 365 auth on startup
  {
    try {
      const { checkMicrosoftOnStartup } = await import('./microsoft/auth.js');
      await checkMicrosoftOnStartup();
    } catch (err) {
      logger.warn('Microsoft startup check failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 4g. Start Gmail watcher if Google Workspace is connected
  {
    try {
      const { startGmailWatcher } = await import('./services/gmail-watcher.js');
      startGmailWatcher();
    } catch (err) {
      logger.warn('Gmail watcher failed to start', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 4h. Start Outlook watcher if Microsoft 365 is connected
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

  // 4i. Start Teams watcher if Microsoft 365 is connected
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

  // 4i-2. Start the daily update checker — refreshes a DB cache of the latest
  // release once a day (model-free). The agent reads it on demand via
  // check_for_update; the owner decides whether to check on a schedule.
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

  // 4j. Backfill model capabilities for any model whose capabilities array is
  // empty. Runs in the background so HTTP boot isn't blocked by Ollama
  // /api/show latency or OpenRouter catalog fetches.
  {
    void (async () => {
      try {
        const { backfillEmptyCapabilities } = await import('./services/capabilities.js');
        await backfillEmptyCapabilities();
        // Seed generation parameter specs for video models now that
        // capabilities are populated (the seed keys off video_generation).
        // No-op for models that already carry a spec.
        const { backfillGenerationParams } = await import('./services/generation-params.js');
        backfillGenerationParams();
        // Seed TTS voice catalogs for audio-generation models now that
        // capabilities are populated. No-op for models that already carry a
        // catalog or have no family seed.
        const { backfillVoiceCatalog } = await import('./services/voice-catalog.js');
        backfillVoiceCatalog();
        // Once the backfill finishes, a previously-unprobed model might
        // now be known to be vision-capable. Re-run the obvious-fallback
        // helper so the platform fallback gets set without the user
        // having to visit Settings → Dojo manually. The earlier startup
        // call (below, before the healer scheduler) handles the case
        // where caps were already populated; this handles the
        // background-probe-completed case.
        const { autoConfigureFallbackVisionModelIfObvious } = await import('./services/vision-model.js');
        autoConfigureFallbackVisionModelIfObvious();
      } catch (err) {
        logger.warn('Capability backfill failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }

  // 4j. Compute RAM-aware num_ctx recommendations for Ollama models that
  // don't have one yet. Separate background task so it doesn't block boot
  // or the capability backfill.
  {
    void (async () => {
      try {
        const { backfillRecommendedNumCtx } = await import('./services/num-ctx-calculator.js');
        await backfillRecommendedNumCtx();
      } catch (err) {
        logger.warn('num_ctx backfill failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }

  // 4j-bis. One-time migration: mirror existing safe-sender lists (all channels)
  // into the contacts store so upgrading users with senders already configured
  // get their contacts without re-saving each list. Gated by a config flag;
  // new adds are mirrored live by the config/append write paths. Fast (small
  // lists), so it runs inline rather than as a background task.
  try {
    const { backfillSafeSenderContacts } = await import('./services/channel-safe-senders.js');
    const r = backfillSafeSenderContacts();
    if (!r.skipped) {
      logger.info('Safe-sender contacts migration complete', { created: r.created, updated: r.updated });
    }
  } catch (err) {
    logger.warn('Safe-sender contacts migration failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 4k. Refresh model pricing for providers whose live API exposes it
  // (primarily OpenRouter). Background so it doesn't block HTTP boot.
  // COALESCE semantics: missing API prices preserve what we already have.
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

  // 4l. Refresh Anthropic / OpenAI / DeepSeek pricing from the LiteLLM
  // community price index. Their own APIs don't return pricing, so this
  // is how we stay current as providers re-price. Background, COALESCE
  // semantics. Status (success/failure + timestamp) is persisted into
  // the config table and surfaced on the Costs page.
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

  // 4m. Resume in-flight video generation jobs. Video is async (1 to 10
  // min); a job submitted before a restart still has a live provider job
  // we need to keep polling. The poller picks up every row still in
  // 'queued'/'polling' and drives it to delivery. Synchronous scan, async
  // poll loops — doesn't block boot.
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

  // Run-once generation jobs (image / audio / music) can't resume
  // mid-flight after a restart, so this clears any leftover queued/running
  // rows instead of resuming them — keeps the dashboard indicator honest.
  {
    try {
      const { startGenerationJobsWorker } = await import('./services/generation-jobs.js');
      startGenerationJobsWorker();
    } catch (err) {
      logger.warn('Generation jobs worker failed to start', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 5. Set up log broadcast
  setLogBroadcast((entry) => {
    broadcast({ type: 'log:entry', entry });
  });

  // 6. Create and start server
  const { app, injectWebSocket } = createServer();

  const server = serve({
    fetch: app.fetch,
    port: PORT,
  }, (info) => {
    logger.info(`Dojo Agent Platform running on http://localhost:${info.port}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.warn(`Port ${PORT} is in use, retrying in 2s...`);
      setTimeout(() => { server.close(); server.listen(PORT); }, 2000);
    } else {
      logger.error('Server error', { error: err.message });
      process.exit(1);
    }
  });

  injectWebSocket(server);

  // Clean up old uploads every 24 hours
  const { cleanupOldUploads } = await import('./gateway/routes/upload.js');
  setInterval(cleanupOldUploads, 24 * 60 * 60 * 1000);
  cleanupOldUploads(); // Run once on startup

  // Auto-start tunnel if enabled (delay to ensure HTTP server is fully ready)
  setTimeout(async () => {
    try {
      const { autoStartTunnel } = await import('./services/tunnel.js');
      autoStartTunnel(PORT);
    } catch (err) {
      logger.warn('Failed to auto-start tunnel', { error: err instanceof Error ? err.message : String(err) });
    }
  }, 3000);

  // Schedule the nightly dreaming cycle for the vault
  try {
    const { scheduleDreamingCycle } = await import('./vault/maintenance.js');
    scheduleDreamingCycle();
  } catch (err) {
    logger.warn('Failed to schedule dreaming cycle', { error: err instanceof Error ? err.message : String(err) });
  }

  // One-shot migration: if the platform has exactly one enabled
  // vision-capable model and no fallback vision model is configured,
  // silently set that single model as the fallback. Preserves working
  // setups for users upgrading from the era when each tool auto-picked
  // its own vision model. Multi-vision-model installs leave the config
  // unset so the Settings → Dojo UI can prompt for an explicit choice.
  try {
    const { autoConfigureFallbackVisionModelIfObvious } = await import('./services/vision-model.js');
    autoConfigureFallbackVisionModelIfObvious();
  } catch (err) {
    logger.warn('autoConfigureFallbackVisionModelIfObvious failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // v2.9.13 — one-shot recovery for recurring tasks that the engine's
  // close-out hardcap silently paused before the recurring-task
  // carve-out landed. Releases the user's daily / scheduled tasks back
  // to their normal cadence without manual intervention.
  try {
    const { recoverEnginePausedRecurringTasks } = await import('./scheduler/runner.js');
    recoverEnginePausedRecurringTasks();
  } catch (err) {
    logger.warn('recoverEnginePausedRecurringTasks failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Schedule the healer cycle (agent spawns on-demand when the cycle fires)
  try {
    const { scheduleHealingCycle, startHealerSelfWatchdog } = await import('./healer/healer-agent.js');
    scheduleHealingCycle();
    // v2.3.19 (error-handling-spec Phase 3) — engine-level safety net so
    // the Healer can't get permanently stuck. Runs every 5 min.
    startHealerSelfWatchdog();
    // v2.3.19 (error-handling-spec Phase 4) — frequent auto-fix sweep for
    // status recovery (stuck/paused/errored agents past their cooldown).
    // Replaces the "wait until 04:00 to unstick a paused agent" behavior.
    const { startFrequentAutoFixes } = await import('./healer/auto-fix.js');
    startFrequentAutoFixes();
    logger.info('Healer cycle scheduled + self-watchdog + frequent auto-fix started');
  } catch (err) {
    logger.warn('Failed to schedule healing cycle', { error: err instanceof Error ? err.message : String(err) });
  }

  // Injury recovery is event-driven — when an agent enters 'error' status,
  // runtime.ts calls onAgentInjured() which schedules a 5-minute grace
  // period, then notifies the Healer agent if the agent hasn't recovered.
  // On startup, rehydrate any agents that were injured before a restart
  // (in-memory timers are lost on restart).
  try {
    const { rehydrateInjuredAgents } = await import('./healer/injury-recovery.js');
    rehydrateInjuredAgents();
  } catch (err) {
    logger.warn('Failed to rehydrate injured agents', { error: err instanceof Error ? err.message : String(err) });
  }

  const timeoutInterval = setInterval(() => {
    try { checkTimeouts(); } catch (err) {
      logger.error('Timeout checker failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }, 30_000);

  const shutdown = (): void => {
    logger.info('Shutting down...');
    clearInterval(timeoutInterval);
    // Stop tunnel gracefully
    import('./services/tunnel.js').then(m => m.stopTunnel()).catch(() => {});
    server.close(async () => {
      const { closeDb } = await import('./db/connection.js');
      closeDb();
      logger.info('Shutdown complete');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error('Fatal startup error', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
