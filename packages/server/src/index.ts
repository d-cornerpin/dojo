import { serve, type ServerType } from '@hono/node-server';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import { createLogger, setLogBroadcast } from './logger.js';
import { getDb } from './db/connection.js';
import { runMigrations } from './db/migrations.js';
import { setConvKeyByRowid, sweepByRowid } from './memory/message-store.js';
import { loadSecrets } from './config/loader.js';
import { createServer } from './gateway/server.js';
import { broadcast } from './gateway/ws.js';
import { checkTimeouts, reArmSpawnTimeouts } from './agent/spawner.js';
import { killTunnelSync } from './services/tunnel.js';
import { getPrimaryAgentId, getPrimaryAgentName, getPMAgentId, isPMEnabled, setPlatformConfig, HOUSEHOLD_AGENT_IDS_KEY } from './config/platform.js';
import { recordBootAttempt, markMigrationsRan, confirmHealthy, readMarker, synthesizeMigrationBootEpisode } from './update-state.js';
import { probeFsCaseInsensitive, setFsCaseInsensitive } from './agent/path-guards.js';

const logger = createLogger('main');
const PORT = parseInt(process.env.DOJO_PORT ?? '3001', 10);

// D-F health-confirm: how long a self-update boot must stay continuously up
// before we flip its update-state marker to healthy (matches the plan's ~90s).
const HEALTH_CONFIRM_DELAY_MS = 90_000;

// Count applied SQL migrations (the _migrations tracking table). Guarded: on a
// brand-new box the table may not exist yet, which reads as 0. Used ONLY by the
// D-F boot sentinel to detect whether a self-update boot changed the schema
// (owner decision 2026-07-06: if it did, the watchdog escalates instead of
// trusting a code-only rollback). Reading the count needs no migrations.ts edit.
function countAppliedMigrations(): number {
  try {
    const row = getDb().prepare('SELECT COUNT(*) AS c FROM _migrations').get() as { c: number } | undefined;
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

// Count the migration SQL files shipped with this build (dist/db/migrations at
// runtime, src/db/migrations under tsx), resolved the SAME way db/migrations.ts
// does. Read-only: it only lists the directory to answer "are there unapplied
// migrations?" without touching the migration runner. Used ONLY by the jump-#1
// self-update detection below.
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

// D-F health-confirm: when this boot is part of a self-update episode, wait for
// ~90s of continuous uptime, then re-check the DB is serving (the same
// db !== 'error' contract /api/health and the watchdog use) and flip the marker
// to healthy, which clears the episode. If the process crashes before the timer
// fires, it never confirms and the watchdog's boot-attempt / wall-clock gate
// takes over. No-op on a normal (non-update) boot.
//
// 'failed-permanently' is also armed HERE (not just the in-flight phases): a
// migration-carrying boot that legitimately finishes AFTER the watchdog's 15-min
// window has, by listen time, already been escalated to 'failed-permanently'. Its
// eventual healthy confirmation is exactly the signal confirmHealthy uses to clear
// that FALSE terminal state (only the 'migration' escalation reason recovers; see
// confirmHealthy). Without arming this phase the recovery would be unreachable.
function scheduleUpdateHealthConfirm(): void {
  const marker = readMarker();
  if (!marker) return;
  if (marker.phase !== 'booting-new' && marker.phase !== 'rolled-back' && marker.phase !== 'failed-permanently') return;
  if (marker.confirmedHealthyAt) return;
  setTimeout(() => {
    try {
      // Same contract the watchdog trusts: a serving DB (SELECT 1 does not throw).
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

// Surface uncaught crashes to the structured log instead of silently
// exiting. Without this, a throw inside a third-party WebSocket event
// listener (Hume SDK, the gateway WS) takes down the process leaving
// only an opaque stderr dump. We still exit so dev-mode (tsx watch)
// restarts cleanly, just leave a breadcrumb first.
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception, process will exit', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  // Best-effort: don't orphan cloudflared on the way out. This crash path
  // skips the graceful SIGTERM shutdown (which stops the tunnel), so kill the
  // child synchronously here. The pidfile reclaim on next boot is the primary
  // safety net; this must never throw.
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

  // Skip if setup hasn't been completed, OOBE will provision the agent
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

  // FA-PC6: prefer the 'auto' sentinel so the smart router picks a working,
  // chat-capable model at call time (the same recovery the runtime uses when it
  // finds a broken agent). The old fallback took the first enabled model by
  // display-name alphabetical order with NO capability filter, so an
  // embedding/media-generation model (which bills $0 and sorts early) could win
  // and leave the primary with a dead brain. Only if 'auto' is missing or
  // disabled do we pin a concrete model, and then we require a chat-capable one:
  // capabilities NOT LIKE generation/embedding, excluding the '__system__'
  // sentinel provider, ordered by display name ASC (unchanged tiebreak). This
  // mirrors the text-capable filter used by the healer and summary writer.
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
           AND m.capabilities NOT LIKE '%generation%'
           AND m.capabilities NOT LIKE '%embedding%'
         ORDER BY m.name ASC
         LIMIT 1
      `).get() as { id: string } | undefined)?.id ?? null;

  db.prepare(`
    INSERT INTO agents (id, name, model_id, system_prompt_path, status, config, created_by,
                        classification, created_at, updated_at)
    VALUES (?, ?, ?, NULL, 'idle', '{"shareUserProfile":true}', 'system', 'sensei', datetime('now'), datetime('now'))
  `).run(
    primaryId,
    primaryName,
    fallbackModelId,
  );

  logger.info('Created primary agent', { id: primaryId, name: primaryName, modelId: fallbackModelId ?? 'none' });
}

// D-A household vault-sharing: seed the `household_agent_ids` allow-list with the
// primary agent id when the config key is absent. Fresh installs get it after
// OOBE (this runs on every boot); EXISTING boxes, where the key predates the
// feature, get it on the next boot (the upgrade path). Idempotent: it only seeds
// when the row is missing, so an onboarded second primary's list is never
// overwritten. No-op until setup completes (the primary id is not authoritative
// before then). Even before this runs, getHouseholdAgentIds() falls back to
// [primary], so recall is correct on the very first boot too; this just persists
// the row so a future second-primary onboarding has a home to append to.
function ensureHouseholdConfig(): void {
  const db = getDb();

  const setupDone = db.prepare("SELECT value FROM config WHERE key = 'setup_completed'").get() as { value: string } | undefined;
  if (!setupDone || setupDone.value !== 'true') {
    return;
  }

  const existing = db.prepare('SELECT value FROM config WHERE key = ?').get(HOUSEHOLD_AGENT_IDS_KEY) as { value: string } | undefined;
  if (existing) {
    return;
  }

  const primaryId = getPrimaryAgentId();
  setPlatformConfig(HOUSEHOLD_AGENT_IDS_KEY, JSON.stringify([primaryId]));
  logger.info('Seeded household_agent_ids allow-list', { members: [primaryId] });
}

// PHASE-0 T12c: the port is the mutual exclusion, so it is taken FIRST.
//
// Everything main() does after this is a mutation of the real database:
// directories, migrations, config seeds, timer re-arms, pollers. The listen used
// to be the LAST thing, so a second instance started against a box that was
// already running rewrote the RUNNING box's database and only then discovered
// the port was taken — and then retried the bind forever, leaving a whole second
// platform (schedulers, sweeps, watchers) alive against the same file.
//
// Binding first inverts that: nothing boots until this process owns the port.
// The old handler's 2s EADDRINUSE retry is kept, because a restart that overlaps
// its predecessor's shutdown must still come up, but it is now BOUNDED and every
// attempt happens before the first database write. When the window passes, the
// duplicate exits instead of living on — launchd/the watchdog restart a process
// that exits, and a loud restart loop against a healthy box is a far better
// outcome than a silent second platform writing to it.
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

  // The real app is built at the end of boot; until then the socket is open and
  // answers every request 503. The watchdog reads a non-2xx as down exactly like
  // a refused connection, so "booting" still looks like "not serving yet".
  let appFetch: ((request: Request, env: unknown) => Response | Promise<Response>) | null = null;
  const server = await bindPortFirst((request, env) =>
    appFetch
      ? appFetch(request, env)
      : new Response(JSON.stringify({ ok: false, error: 'Dojo is starting' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }));

  server.on('error', (err: NodeJS.ErrnoException) => {
    logger.error('Server error', { error: err.message, code: err.code ?? null });
    process.exit(1);
  });

  // System-dependency check (brew packages like whisper-cpp). Runs in the
  // background, we don't block server startup on a `brew install` that
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

  // 1b. PHASE-0 T10: MEASURE whether this box folds path case (APFS does, ext4
  // does not) — every sensitive-path guard reads the flag. See path-guards.ts.
  const fsFolds = probeFsCaseInsensitive(path.join(os.homedir(), '.dojo', 'data'), fs);
  setFsCaseInsensitive(fsFolds);
  logger.info('Filesystem case sensitivity probed', { caseInsensitive: fsFolds });

  // 2. Load secrets
  loadSecrets();

  // 2b. Refresh the watchdog from the platform bundle BEFORE migrations run.
  // The in-app updater only rewrites ~/.dojo/platform, so the new watchdog (with
  // its auto-rollback + read-only-WAL fixes, and the patience that lets a long
  // migration boot finish) rides inside platform/watchdog-dist and we self-install
  // it here. ORDER MATTERS: refresh THEN migrate, so on the very first jump from an
  // old updater the PATIENT new watchdog is the one supervising the (potentially
  // long, 30-migration) first-boot window, instead of the old 3.1.9 watchdog that
  // kickstarts the box after ~10 min of health-down and would kill it mid-
  // migration. Best-effort, darwin+prod only, never fails the boot.
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
  // D-F boot sentinel: if this boot is part of a self-update episode, count the
  // attempt BEFORE migrations run (a crash mid-migration still increments the
  // tally the watchdog reads). Then, if a migration APPLIED during the episode,
  // flag it so the watchdog escalates loudly instead of trusting a code-only
  // rollback (owner decision 2026-07-06): the restored old build could choke on
  // the new schema. On a normal (non-update) boot, recordBootAttempt returns null
  // and this is all inert.
  const migCountBefore = countAppliedMigrations();
  let bootEpisode = recordBootAttempt();
  // Jump-#1: an OLD updater (pre-D-F) may have swapped the platform WITHOUT writing
  // a marker, so recordBootAttempt sees no episode even though this boot is a real
  // self-update carrying new migrations. Detect that here and synthesize a
  // 'booting-new' episode BEFORE migrations run, so the freshly-installed patient
  // watchdog (step 2b) has a phase to read across the long first-boot window.
  // Gated tightly so it can only fire on a genuine self-update: some migrations
  // ALREADY applied (an existing box, never a fresh install, which has 0) AND more
  // are now pending (the new build brought schema the DB has not applied yet).
  if (!bootEpisode && migCountBefore > 0 && countAvailableMigrationFiles() > migCountBefore) {
    const { getCurrentVersion } = await import('./gateway/routes/update.js');
    bootEpisode = synthesizeMigrationBootEpisode(getCurrentVersion());
    logger.warn('D-F: self-update boot detected without an updater marker (old-updater jump); synthesized a migration-carrying boot episode so the watchdog stays patient through the migration window and escalates rather than rolls back if it fails');
  }
  runMigrations();
  if (bootEpisode && countAppliedMigrations() > migCountBefore) {
    markMigrationsRan();
    logger.warn('D-F: a database migration ran during a self-update boot; a failed boot will escalate, not auto-rollback');
  }

  // 3b. One-shot crash cleanup: agents left in 'working' by a hard stop, and
  // model pointers left dangling by a provider re-create. Used to run at
  // runtime.ts's module scope, i.e. during import, which is ahead of the port
  // bind (PHASE-0 T12c) — a duplicate instance rewrote the running box's agent
  // rows before it ever learned the port was taken. It runs here instead, after
  // the bind proved this process owns the box and after the migrations that
  // create the table it reads.
  try {
    const { runStartupRecoverySweep } = await import('./agent/runtime.js');
    runStartupRecoverySweep();
  } catch (err) {
    logger.warn('Startup recovery sweep failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
  }

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
  } catch { /* ignore, migration module may not exist yet */ }

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

  // 4'. Seed the D-A household vault-sharing allow-list (upgrade + fresh path).
  ensureHouseholdConfig();

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

  // 4b1. Boot staleness sweep (incident 2026-07-02). When the box has been offline or
  // behind for a while, its message backlog fills with role='user' rows whose conv_key is
  // still NULL (unanswered/unstamped), old human inbounds AND old engine events. The boot
  // re-drain below, plus the runtime/engine drains, treat those as freshly-waiting and would
  // force-wake EVERY agent into a mass "catch up on weeks of work" storm (agents re-running
  // ancient reminders, the healer backfilling a diagnostic for every past day, a sub-agent
  // publishing without approval). A message pending from a genuine QUICK restart is
  // seconds-to-minutes old; anything older than 30 minutes at boot is stale history, not
  // in-flight work. Stamp those stale rows with a dead sentinel conv_key so no drain can pick
  // them up, silently, with NO user prompt (the user has no context to judge "catch up on
  // weeks of backlog?" and one wrong 'yes' is irreversible).
  //
  // SCOPE, this touches the messages table ONLY (conversation/context/notification rows). It
  // NEVER touches the tracker (tasks/projects/schedules): those are the system of record, and
  // the PM keeps picking up and completing stale tracker tasks at its normal pace, exactly as
  // before. Nothing is completed, paused, expired, or deleted. A pending message UNDER 30
  // minutes old is left NULL so the re-drain below still catches a genuine just-before-restart
  // message.
  {
    try {
      const db = getDb();
      // D11: how many stale UNANSWERED rows are genuine authorized-human asks
      // (not engine notices, not A2A)? A quick restart with a handful of these is
      // a person waiting on an answer, HOLD those for the re-drain below to
      // serve (never silently drop a question). A large backlog is stale history
      // (box was offline for a long time), suppress it as before.
      const HUMAN_HOLD_LIMIT = 5;
      const HUMAN_PREDICATE =
        `lane = 'owner' AND source_agent_id IS NULL AND a2a_thread_id IS NULL`;
      // AUDIT-FIX: count PER AGENT (a global count let 6 asks across 6 agents all
      // get swept), and only count SERVABLE rows (>= the agent's session start,
      // which is the re-drain's own floor). Holding an unservable row parked it in
      // limbo: never served by the re-drain, never swept, re-held every boot.
      const SERVABLE = `${HUMAN_PREDICATE} AND m.created_at >= COALESCE((SELECT session_started_at FROM agents WHERE id = m.agent_id), '1970-01-01')`;
      const heldAgents = (db.prepare(
        `SELECT m.agent_id AS id, COUNT(*) AS c FROM messages m
          WHERE m.role = 'user' AND m.conv_key IS NULL AND m.swept_at IS NULL
            AND m.created_at < datetime('now', '-30 minutes')
            AND ${SERVABLE}
          GROUP BY m.agent_id HAVING COUNT(*) <= ${HUMAN_HOLD_LIMIT}`,
      ).all() as Array<{ id: string; c: number }>);
      const heldTotal = heldAgents.reduce((s, a) => s + a.c, 0);
      const heldIdList = heldAgents.map((a) => `'${a.id.replace(/'/g, "''")}'`).join(',');
      // D11: mark stale rows SWEPT (drain-suppression) instead of OVERWRITING
      // conv_key. Overwriting destroyed the row's conversation identity so recall
      // returned the agent's replies but not what the user said. swept_at keeps
      // conv_key intact (recall/scoping derive the true key) while the waiting
      // query + engine-drain skip swept rows, so a restart still can't re-run
      // weeks-old backlog. When an agent has only a few servable human asks stale,
      // EXCLUDE those from the sweep so the re-drain below serves them.
      //
      // D8: also EXCLUDE engine events still inside their delivery lifecycle
      // (migration 084), i.e. rows carrying proof of an in-process delivery:
      // a future retry backoff (next_attempt_at > now) or 1-4 recorded failed
      // attempts. Only the D8 abort-revert path ever writes that state, so mass
      // stale backlog (the boot-storm class this sweep exists for) has
      // delivery_attempts = 0 / next_attempt_at NULL and is swept silently
      // exactly as before. The exclusion cannot weaken the storm protection:
      // getPendingEngineEvent's own eligibility requires created_at within the
      // 6-hour expiry horizon AND attempts < 5, so nothing older than 6 hours
      // can EVER wake an agent regardless of what survives this sweep; an
      // in-lifecycle row past the horizon is disposed LOUDLY (swept + one
      // owner notice, which never wakes anyone) at the first eligibility
      // consult. Exhausted rows (attempts >= 5) are not excluded here. The
      // IS NOT NULL guard matters: without it a NULL next_attempt_at makes
      // the comparison NULL, the OR NULL, the AND NULL, and NOT(NULL) is
      // NULL = row skipped, which would shield ALL plain engine backlog
      // from the sweep (verified against an aged DB copy).
      //
      // T4: the row SELECTION is unchanged — the predicate below is carried verbatim,
      // it just names the candidates now instead of updating them in place. The
      // disposal itself goes through the writer module's sweep, which re-applies the
      // same two guards per row (`swept_at IS NULL`, and `conv_key IS NULL` via
      // requireUnclaimed), so a row that was claimed in between is still not ours.
      const staleRows = db.prepare(
        `SELECT m.rowid AS rowid, m.agent_id AS agent_id FROM messages AS m
          WHERE m.role = 'user' AND m.conv_key IS NULL AND m.swept_at IS NULL
            AND m.created_at < datetime('now', '-30 minutes')
            AND NOT (m.lane = 'events'
                     AND ((m.next_attempt_at IS NOT NULL AND m.next_attempt_at > datetime('now'))
                          OR (m.delivery_attempts > 0 AND m.delivery_attempts < 5)))
            ${heldAgents.length > 0 ? `AND NOT (${SERVABLE} AND m.agent_id IN (${heldIdList}))` : ''}`,
      ).all() as Array<{ rowid: number; agent_id: string }>;
      let swept = 0;
      for (const r of staleRows) {
        swept += sweepByRowid({ rowid: r.rowid, agentId: r.agent_id, requireUnclaimed: true });
      }
      // T6: the SECOND sweep arm is gone. D-A step 4 split engine events across two
      // physical tables, so this sweep needed a store arm or a stale store engine event
      // survived the restart and re-fired via the merged boot re-drain. Engine events
      // are `lane='events'` rows in `messages` now, and the predicate above already
      // reaches them: `lane = 'events'` is exactly the `origin_kind = 'engine'` clause
      // the store arm carried, and the held-agents exclusion cannot touch them because
      // HUMAN_PREDICATE is owner-lane only.
      // requirement preserved: a stale, never-attempted engine event is drain-suppressed
      // at boot, wherever it was queued, while one still inside its delivery lifecycle
      // (a future backoff or 1-4 recorded attempts) survives to be retried.
      if (swept > 0 || heldTotal > 0) {
        logger.info(`Boot staleness sweep: drain-suppressed ${swept} stale (>30m) row(s) via swept_at (conv_key preserved for recall)${heldTotal > 0 ? `; HELD ${heldTotal} genuine human ask(s) across ${heldAgents.length} agent(s) for the re-drain` : ''} (tracker untouched)`);
      }
    } catch (err) {
      logger.warn('Boot staleness sweep failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // 4b1. D19: boot crash-reconciliation, split "claimed" from "answered".
  // A crash AFTER the pickup stamp claimed a human ask (conv_key set) but BEFORE
  // the reply was produced leaves the row reading SERVED forever: the in-memory
  // revert (loop.ts revertTriggerStampOnAbort) never ran, and the re-drain below
  // sees nothing waiting. A claimed human row is genuinely ANSWERED only if a
  // later assistant/tool row carries the SAME conv_key (the turn-end stamp). Revert
  // claims with no such reply so the re-drain re-serves them. Scoped to a recent
  // window (a fresh crash) and biased to RE-SERVE (a possible duplicate reply) over
  // DROP (silent loss). Uses idx_messages_agent_created for the reply check.
  {
    try {
      const db = getDb();
      const claimed = db.prepare(
        `SELECT rowid, conv_key, agent_id, created_at FROM messages
          WHERE role = 'user' AND conv_key IS NOT NULL AND swept_at IS NULL
            AND conv_key NOT IN ('engine', 'engine-steer')
            AND conv_key NOT LIKE 'park:%' AND conv_key NOT LIKE 'relayed:%'
            AND source_agent_id IS NULL AND a2a_thread_id IS NULL
            AND lane = 'owner'
            AND created_at >= datetime('now', '-30 minutes')`,
      ).all() as Array<{ rowid: number; conv_key: string; agent_id: string; created_at: string }>;
      const hasReply = db.prepare(
        `SELECT 1 FROM messages WHERE agent_id = ? AND role IN ('assistant', 'tool')
            AND conv_key = ? AND created_at >= ? LIMIT 1`,
      );
      let reArmed = 0;
      for (const r of claimed) {
        if (hasReply.get(r.agent_id, r.conv_key, r.created_at)) continue; // genuinely answered
        setConvKeyByRowid({ rowid: r.rowid, agentId: r.agent_id, value: null });
        reArmed++;
      }
      if (reArmed > 0) {
        logger.warn(`Boot crash-reconciliation: re-armed ${reArmed} claimed-but-unanswered human ask(s) for the re-drain (crash between pickup and reply; tracker untouched)`);
      }
    } catch (err) {
      logger.warn('Boot crash-reconciliation failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // 4b2. Re-drain unanswered conversations after restart (comms-audit D-1).
  // An inbound that arrived before a restart is durably persisted with conv_key
  // NULL (unanswered), but the in-memory wakeup that would trigger its turn is
  // lost on restart, so it would sit unanswered until the NEXT inbound happens
  // to poke the runtime. Nothing else re-reads it: the waiting SET is durable,
  // the TRIGGER to read it was not. Sweep every agent for waiting human
  // conversations and kick a drain, so a message the user sent is never silently
  // forgotten across a restart (invariant 2, never forgets to answer).
  // handleMessage('') re-reads the DB and the normal serving path takes over;
  // it is idempotent (an already-served row has a conv_key and is skipped), and
  // sends are staggered so a fleet of agents doesn't fire all at once.
  try {
    const db = getDb();
    const { getWaitingHumanConversations, getPendingEngineEvent } = await import('./agent/v2/counterparty.js');
    const { findUnrepliedAssignForAgent } = await import('./agent/a2a-replies.js');
    const { getAgentRuntime } = await import('./agent/runtime.js');
    // C20: exclude terminated agents, the re-drain must never resurrect a dead agent.
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
        // both, runV2Turn re-classifies and serves whichever is owed.
        const owesHuman = getWaitingHumanConversations(id).length > 0;
        // Boot staleness (incident 2026-07-02): only re-drain an A2A assign from the last 30
        // minutes, a genuine just-before-restart request. An older unreplied assign is stale
        // backlog and must not force-wake the agent (matches the message sweep in 4b1). The
        // human side is already covered because 4b1 stamped stale human rows out of the
        // waiting set.
        const owesA2A = !owesHuman && findUnrepliedAssignForAgent(id, 20, 30) !== null;
        // D8: also re-drain a pending-ELIGIBLE engine event (a reminder mid-delivery
        // when the box restarted). Eligibility, not raw age: getPendingEngineEvent
        // gates on the migration-084 lifecycle (unclaimed + unswept + attempts < 5 +
        // backoff passed + created_at within the 6-hour expiry horizon), and the 4b1
        // sweep above has already suppressed stale attempts=0 backlog, so a restart
        // rescues an in-flight reminder without re-running weeks-old history. The
        // call also expires exhausted events loudly (owner notice, no wake).
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

  // 4b3. D13: boot re-drain of PARKED owner questions (fail-closed backstop).
  // A parked owner question (conv_key 'park:<thread>') whose reply never came, or
  // whose reply arrived but crashed before the relay, previously sat open FOREVER:
  // nothing re-read parks after a restart (the 4b2 re-drain only covers waiting
  // conversations and asks under 30 minutes), so "ask X and get back to me" ended
  // in permanent silence with everything looking healthy. resolveParksAtBoot scans
  // ALL open parks (bounded + age-capped so boot stays fast): it relays any answer
  // that already exists, fails closed (deterministic owner notice on the park's own
  // channel) when the asked agent is terminated or the park is past TTL, and leaves
  // fresh parks for the periodic TTL sweep. It only relays or marks message rows,
  // it NEVER wakes an agent, so it cannot start a boot storm and needs no
  // wake-budget accounting. Delayed so the channel bridges (iMessage/Twilio) are up
  // before any notice goes out; a bridge that is still down just means the notice
  // takes the guaranteed dashboard fallback.
  setTimeout(() => {
    void (async () => {
      try {
        const { resolveParksAtBoot } = await import('./agent/a2a-transport.js');
        const r = await resolveParksAtBoot();
        if (r.relayedReplies > 0 || r.failedClosed > 0 || r.leftOpen > 0) {
          logger.info(`Boot park re-drain: relayed ${r.relayedReplies} stranded repl(ies), failed ${r.failedClosed} park(s) closed, left ${r.leftOpen} open for the TTL sweep`);
        }
      } catch (err) {
        logger.warn('Boot park re-drain failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  }, 20_000);

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

  // v2.10.3, Imaginer agent retired. Image generation is now a
  // platform-config model picker (Settings → Dojo → Image Generation
  // Model) and the `image_create` tool calls that model directly.
  // Migration 059 terminates the legacy Imaginer agent row. This
  // step intentionally left empty for the gap.
  // 4c3. (Removed, Imaginer agent no longer auto-spawned)

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
      // Idempotent, runs on every boot but is a no-op once clean.
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

  // 4i-1. Start the workspace reconnect probe. A benched Google/Microsoft
  // account (connected=0) has no automatic way back on its own: before this,
  // a single bad token-refresh response permanently removed a healthy account
  // from every sweep until a human re-authenticated in Settings (incident
  // 2026-07-08). Every ~30 min this re-tests benched accounts that still hold a
  // refresh token and un-benches any whose refresh token still works. Cheap:
  // no network work unless something is actually benched.
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

  // 4i-2. Start the daily update checker, refreshes a DB cache of the latest
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

  // 4i-3. Prune old platform backups + set-aside failed builds at boot (FA-D5).
  // The post-update/rollback prune is fire-and-forget and can be cut short by
  // the scheduled process.exit that restarts us, so a next-boot sweep is the
  // durable guarantee that both pools stay bounded (each capped to the newest
  // few, keeping at least one real rollback target). Best-effort: a prune
  // failure must never block boot.
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

  // 4j-bis. Every-boot reconcile: mirror the safe-sender lists (all channels)
  // into the contacts store so every trusted sender has a contact record the
  // agent can resolve by name. Self-healing safety net for senders added before
  // live mirroring existed (the live config/append/agent write paths keep new
  // adds in sync). Idempotent + additive + fast (small lists), so it runs inline
  // rather than as a background task. See backfillSafeSenderContacts for the
  // dropped-flag tradeoff.
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
  // poll loops, doesn't block boot.
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
  // rows instead of resuming them, keeps the dashboard indicator honest.
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

  // 6. Boot is done: hand the already-listening socket its real handler. Up to
  // here it answered 503 (see bindPortFirst at the top of main).
  const { app, injectWebSocket } = createServer();
  appFetch = app.fetch;
  injectWebSocket(server);
  logger.info('Dojo Agent Platform is serving');

  // D-F health-confirm: the server is now listening. If this boot is part of a
  // self-update episode, arm the ~90s uptime timer that flips the update-state
  // marker to healthy once the DB is confirmed serving. No-op otherwise.
  scheduleUpdateHealthConfirm();

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

  // D4: schedule the incremental embedding-backfill drain. Channel inbound
  // (iMessage / SMS / email / Teams) is persisted at ~80 scattered sites and
  // none embed at write, so before this drain July had 0 embedded messages
  // across all channels, anything told to the agent over a channel was
  // invisible to vector recall. runBackfill only touches rows missing an
  // embedding (LEFT JOIN filter) and guards against overlapping runs, so it
  // self-limits once caught up. First pass is delayed so boot isn't slowed; the
  // big one-time history catch-up runs in the background, later passes are light.
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

  // D13: TTL sweep for parked owner questions, the "no reply EVER comes" backstop.
  // Every 10 minutes, any open park older than the park TTL is failed CLOSED: the
  // engine relays a deterministic "could not get an answer" notice to the owner on
  // the park's own channel (the same delivery path a real reply uses) and consumes
  // the park (park: -> relayed:) so it fires exactly once. If the reply actually
  // arrived but was never relayed, the sweep relays the REAL answer instead.
  // Engine-enforced and model-independent: the owner is never left in silence
  // because the asked agent died, was terminated, or dropped the ask.
  setInterval(() => {
    void (async () => {
      try {
        const { sweepExpiredParks } = await import('./agent/a2a-transport.js');
        await sweepExpiredParks();
      } catch (err) {
        logger.warn('park TTL sweep failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  }, 10 * 60_000);

  // D17: one-time re-embed of vault entries left with a NULL embedding (pre-C12
  // Ollama drops). Without an embedding they can never match a semantic
  // vault_search, only an exact LIKE, so a fact stored there is effectively
  // unfindable by meaning. Best-effort, delayed so it doesn't compete with boot.
  setTimeout(() => {
    void (async () => {
      try {
        const { reembedNullVaultEntries } = await import('./vault/store.js');
        await reembedNullVaultEntries();
      } catch (err) {
        logger.debug('reembedNullVaultEntries failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }, 90_000);

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

  // The v2.9.13 boot-time recovery for engine-paused recurring tasks was
  // retired 2026-07-21: the auto-pause writer it healed was demolished in the
  // two-key wave, so the victim set is fixed and migration 110 releases it
  // once, as data, instead of a prose-signature scan on every boot.

  // Schedule the healer cycle (agent spawns on-demand when the cycle fires)
  try {
    const { scheduleHealingCycle, startHealerSelfWatchdog } = await import('./healer/healer-agent.js');
    scheduleHealingCycle();
    // v2.3.19 (error-handling-spec Phase 3), engine-level safety net so
    // the Healer can't get permanently stuck. Runs every 5 min.
    startHealerSelfWatchdog();
    // v2.3.19 (error-handling-spec Phase 4), frequent auto-fix sweep for
    // status recovery (stuck/paused/errored agents past their cooldown).
    // Replaces the "wait until 04:00 to unstick a paused agent" behavior.
    const { startFrequentAutoFixes } = await import('./healer/auto-fix.js');
    startFrequentAutoFixes();
    logger.info('Healer cycle scheduled + self-watchdog + frequent auto-fix started');
  } catch (err) {
    logger.warn('Failed to schedule healing cycle', { error: err instanceof Error ? err.message : String(err) });
  }

  // Injury recovery is event-driven, when an agent enters 'error' status,
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

  // FA-P1: sweep stale destructive-approval requests on boot, then on the same
  // 30s cadence as the agent reaper below. Bounded/idempotent: re-wakes the
  // primary at most once per request, then loudly expires anything still undecided
  // at the TTL. Reuses this existing maintenance home rather than a new timer.
  try {
    const { sweepStaleApprovals } = await import('./agent/destructive-gate.js');
    sweepStaleApprovals().catch((err) => {
      logger.warn('Destructive-approval boot sweep failed', { error: err instanceof Error ? err.message : String(err) });
    });
  } catch (err) {
    logger.warn('Destructive-approval boot sweep import failed', { error: err instanceof Error ? err.message : String(err) });
  }

  // P3 boot re-arm: spawn timeout timers are in-memory and vanish on restart.
  // Rebuild them from agents.timeout_at so a pending creator decision survives a
  // reboot (overdue-at-boot fires the decision notice immediately). Idempotent
  // with the 30s checkTimeouts sweep below.
  try { reArmSpawnTimeouts(); } catch (err) {
    logger.warn('Spawn timeout boot re-arm failed', { error: err instanceof Error ? err.message : String(err) });
  }

  const timeoutInterval = setInterval(() => {
    try { checkTimeouts(); } catch (err) {
      logger.error('Timeout checker failed', { error: err instanceof Error ? err.message : String(err) });
    }
    import('./agent/destructive-gate.js')
      .then(({ sweepStaleApprovals }) => sweepStaleApprovals())
      .catch((err) => logger.warn('Destructive-approval sweep failed', { error: err instanceof Error ? err.message : String(err) }));
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
