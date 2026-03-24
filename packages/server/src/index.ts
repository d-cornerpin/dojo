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

const PLATFORM_DIRS = [
  path.join(os.homedir(), '.dojo'),
  path.join(os.homedir(), '.dojo', 'data'),
  path.join(os.homedir(), '.dojo', 'logs'),
  path.join(os.homedir(), '.dojo', 'prompts'),
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

  // 1. Create required directories
  ensureDirectories();

  // 2. Load secrets
  loadSecrets();

  // 3. Run database migrations
  runMigrations();

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

  // 4d. Start iMessage bridge if enabled
  {
    const db = getDb();
    const imEnabled = db.prepare("SELECT value FROM config WHERE key = 'imessage_enabled'").get() as { value: string } | undefined;
    const imRecipient = db.prepare("SELECT value FROM config WHERE key = 'imessage_recipient'").get() as { value: string } | undefined;
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
      const { checkGwsOnStartup } = await import('./google/auth.js');
      checkGwsOnStartup();
    } catch (err) {
      logger.warn('Google Workspace startup check failed', {
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

  // Auto-start tunnel if enabled
  try {
    const { autoStartTunnel } = await import('./services/tunnel.js');
    autoStartTunnel(3000); // Dashboard port
  } catch (err) {
    logger.warn('Failed to auto-start tunnel', { error: err instanceof Error ? err.message : String(err) });
  }

  // Schedule the nightly dreaming cycle for the vault
  try {
    const { scheduleDreamingCycle } = await import('./vault/maintenance.js');
    scheduleDreamingCycle();
  } catch (err) {
    logger.warn('Failed to schedule dreaming cycle', { error: err instanceof Error ? err.message : String(err) });
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
