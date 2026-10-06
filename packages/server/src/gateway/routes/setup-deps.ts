// ════════════════════════════════════════
// Setup Dependencies & Permissions API
// Used by the OOBE wizard
// ════════════════════════════════════════

import { Hono } from 'hono';
import { execSync, exec, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { deleteAllForAgent } from '../../memory/message-store.js';
import { noteRouteFailure, routeFailure } from './route-failure.js';
import { homeDir } from '../../home.js';
import { idleStreamDeadline } from '../../services/idle-stream-deadline.js';
import { attachIdleBound } from '../../child-idle-bound.js';

const logger = createLogger('setup-deps');

export const setupDepsRouter = new Hono();

// ── Helper ──

// Extend PATH to include Homebrew locations and npm-global fallback (launchd has minimal PATH)
const EXTENDED_PATH = [
  path.join(homeDir(), '.npm-global', 'bin'),
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
].join(':');

const execEnv = { ...process.env, PATH: EXTENDED_PATH };

function cmdExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { encoding: 'utf-8', timeout: 5000, env: execEnv });
    return true;
  } catch { return false; }
}

function cmdOutput(cmd: string, timeout = 5000): string {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout, maxBuffer: 1024 * 1024, env: execEnv }).trim();
  } catch { return ''; }
}

// ══════════════════════════════════════
// Dependencies
// ══════════════════════════════════════

// GET /deps/check — check all dependencies
setupDepsRouter.get('/deps/check', async (c) => {
  const nodeVersion = cmdOutput('node --version');
  const hasBrew = cmdExists('brew');
  const hasOllama = cmdExists('ollama');
  const hasCli = cmdExists('cliclick');

  // Check Ollama running
  let ollamaRunning = false;
  try {
    const resp = await fetch('http://localhost:11434', { signal: AbortSignal.timeout(3000) });
    ollamaRunning = resp.ok || resp.status === 200;
  } catch { /* not running */ }

  // Check Playwright Chromium
  const pwCacheDirs = [
    path.join(homeDir(), 'Library', 'Caches', 'ms-playwright'),
    path.join(homeDir(), '.cache', 'ms-playwright'),
  ];
  const hasPlaywright = pwCacheDirs.some(d => {
    try { return fs.existsSync(d) && fs.readdirSync(d).some(f => f.includes('chromium')); }
    catch { return false; }
  });

  // Check gws CLI and gcloud
  const hasGws = cmdExists('gws');
  const hasGcloud = cmdExists('gcloud') || fs.existsSync('/opt/homebrew/share/google-cloud-sdk/bin/gcloud');

  // Check nomic-embed-text
  let hasNomic = false;
  if (ollamaRunning) {
    try {
      const resp = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        const data = await resp.json() as { models?: Array<{ name: string }> };
        hasNomic = data.models?.some(m => m.name.includes('nomic-embed-text')) ?? false;
      }
    } catch { /* ignore */ }
  }

  return c.json({
    ok: true,
    data: {
      node: { installed: true, version: nodeVersion },
      brew: { installed: hasBrew },
      ollama: { installed: hasOllama, running: ollamaRunning },
      cliclick: { installed: hasCli },
      playwright: { installed: hasPlaywright },
      nomic: { installed: hasNomic },
      gws: { installed: hasGws },
      gcloud: { installed: hasGcloud },
    },
  });
});

// POST /deps/install/:dep — install a specific dependency
setupDepsRouter.post('/deps/install/:dep', async (c) => {
  const dep = c.req.param('dep');

  try {
    switch (dep) {
      case 'ollama': {
        if (!cmdExists('brew')) return c.json({ ok: false, error: 'Homebrew required' }, 400);
        // Use --cask to install the full macOS app (background service, PATH setup, etc.)
        // Falls back to formula if cask fails (e.g., headless server)
        try {
          await installIdleBounded('brew install --cask ollama');
        } catch {
          await installIdleBounded('brew install ollama');
        }
        return c.json({ ok: true, data: { installed: true } });
      }
      case 'ollama-start': {
        // Start ollama serve in background
        exec('ollama serve', { timeout: 0, env: execEnv }); // fire and forget
        // Wait a moment for it to start
        await new Promise(r => setTimeout(r, 3000));
        try {
          const resp = await fetch('http://localhost:11434', { signal: AbortSignal.timeout(5000) });
          return c.json({ ok: true, data: { running: resp.ok || resp.status === 200 } });
        } catch (err) {
          noteRouteFailure(c, logger, err);
          return c.json({ ok: true, data: { running: false, message: 'Starting...' } });
        }
      }
      case 'cliclick': {
        if (!cmdExists('brew')) return c.json({ ok: false, error: 'Homebrew required' }, 400);
        await installIdleBounded('brew install cliclick');
        return c.json({ ok: true, data: { installed: true } });
      }
      case 'playwright': {
        await installIdleBounded('npx playwright install chromium', { cwd: process.cwd() });
        return c.json({ ok: true, data: { installed: true } });
      }
      case 'gws': {
        // Try global install first (works on Homebrew Apple Silicon where prefix is user-writable).
        // If EACCES, reconfigure npm to use ~/.npm-global and retry — avoids needing sudo.
        try {
          await installIdleBounded('npm install -g @googleworkspace/cli');
        } catch (firstErr) {
          const errMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
          if (errMsg.includes('EACCES')) {
            const globalDir = path.join(homeDir(), '.npm-global');
            execSync(`mkdir -p "${globalDir}"`, { encoding: 'utf-8', env: execEnv });
            execSync(`npm config set prefix "${globalDir}"`, { encoding: 'utf-8', env: execEnv });
            const npmGlobalEnv = { ...execEnv, PATH: `${globalDir}/bin:${execEnv.PATH}` };
            await installIdleBounded('npm install -g @googleworkspace/cli', { env: npmGlobalEnv });
          } else {
            throw firstErr;
          }
        }
        return c.json({ ok: true, data: { installed: true } });
      }
      case 'gcloud': {
        if (!cmdExists('brew')) return c.json({ ok: false, error: 'Homebrew required' }, 400);
        await installIdleBounded('brew install --cask gcloud-cli');
        return c.json({ ok: true, data: { installed: true } });
      }
      default:
        return c.json({ ok: false, error: `Unknown dependency: ${dep}` }, 400);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to install ${dep}`, { error: msg });
    return c.json({ ok: false, error: msg }, 500);
  }
});

// ══════════════════════════════════════
// Ollama Models
// ══════════════════════════════════════

// GET /ollama/models — list installed models
setupDepsRouter.get('/ollama/models', async (c) => {
  try {
    const resp = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return c.json({ ok: false, error: 'Ollama not responding' }, 502);
    const data = await resp.json() as { models?: Array<{ name: string; size: number; details?: { parameter_size?: string } }> };
    return c.json({ ok: true, data: data.models ?? [] });
  } catch (err) {
    return routeFailure(c, logger, err, { status: 502, message: 'Cannot connect to Ollama' });
  }
});

// ── Pull progress state (pollable) ──

let currentPullProgress: {
  model: string;
  status: string;
  completed: number;
  total: number;
  layers: number;
  error: string | null;
} | null = null;

// ── t114 (census U8) — the pull's three bounds, each named for its own job ──
// The old flat 1,800,000 was asked to be all three at once. A registry that never answers is a
// different failure from one that stops mid-download, and neither is "this model is too big".
const OLLAMA_PULL_FIRST_BYTE_MS = 60_000;
const OLLAMA_PULL_IDLE_MS = 2 * 60_000;
const OLLAMA_PULL_CEILING_MS = 6 * 60 * 60_000;

// ── t114 (CENSUS U22) — AN INSTALLER THAT IS DOWNLOADING IS NOT A WEDGED INSTALLER ──
//
// THE DEFECT: every dependency install was an `execSync` with a flat total cap — brew cask 180s,
// brew formula 120s, `npx playwright install chromium` 180s, `npm install -g` 120s, gcloud-cli
// 300s. Each of those routinely exceeds its cap on an ordinary connection while downloading
// perfectly, and the kill is a SIGKILL of a package manager mid-write: brew and npm are left
// partially installed behind a generic error, which is worse than not having started, because the
// next attempt begins from a broken tree.
//
// Every one of these tools reports progress continuously, so the fix is the shared idle bound —
// a download that is talking keeps going, a genuinely stuck one is still ended, and a ceiling
// that does not re-arm keeps a runaway bounded. `execSync` becomes a spawn because a synchronous
// call has no per-chunk signal to read; the route handlers are already async.
const INSTALL_IDLE_MS = 90_000;
const INSTALL_CEILING_MS = 60 * 60_000;

/**
 * Run an installer under an output-idle bound, in the shape `execSync` was called in here.
 * Throws on failure like `execSync` did, with a message naming which bound fired when one did,
 * so the route's own error path keeps working unchanged.
 */
async function installIdleBounded(cmd: string, opts?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<string> {
  const child = spawn('/bin/sh', ['-c', cmd], {
    ...(opts?.cwd ? { cwd: opts.cwd } : {}),
    env: opts?.env ?? execEnv,
  });
  try {
    const { stdout, stderr } = await attachIdleBound(child, {
      idleMs: INSTALL_IDLE_MS, ceilingMs: INSTALL_CEILING_MS,
    });
    return stdout || stderr;
  } catch (err) {
    const f = err as { message?: string; stderr?: string; stdout?: string };
    const detail = (f.stderr || f.stdout || '').trim().slice(0, 400);
    throw new Error(`${cmd} failed${f.message ? `: ${f.message}` : ''}${detail ? ` — ${detail}` : ''}`);
  }
}

// GET /ollama/pull-progress — poll current pull progress
setupDepsRouter.get('/ollama/pull-progress', (c) => {
  return c.json({ ok: true, data: currentPullProgress });
});

// POST /ollama/pull — pull a model with progress tracking
setupDepsRouter.post('/ollama/pull', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.model) return c.json({ ok: false, error: 'model is required' }, 400);

  const model = body.model as string;
  currentPullProgress = { model, status: 'starting', completed: 0, total: 0, layers: 0, error: null };

  const pullDeadline = idleStreamDeadline({
    firstByteMs: OLLAMA_PULL_FIRST_BYTE_MS,
    idleMs: OLLAMA_PULL_IDLE_MS,
    ceilingMs: OLLAMA_PULL_CEILING_MS,
  });

  try {
    const resp = await fetch('http://localhost:11434/api/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      // ── t114 (CENSUS U8) — THE PULL IS BOUNDED BY SILENCE, NOT BY A HALF-HOUR WALL ──
      //
      // THE DEFECT: a flat 30 minutes covering the whole streamed pull. A 70 GB model on a home
      // line takes longer than that, so the download was aborted mid-transfer WHILE
      // `digestProgress` (built ten lines below this clock) was actively tracking real bytes
      // arriving — the progress fact was in hand and the clock never consulted it. The UI bar was
      // left frozen at whatever fraction it had reached, which is the part a user actually sees.
      //
      // Ollama streams a JSON progress line per chunk, so arrival is the measured fact of
      // liveness. The bound re-arms on each line; a registry that goes quiet is still cut, and a
      // non-re-arming ceiling keeps a pull that dribbles for ever from holding the route open.
      signal: pullDeadline.signal,
    });

    if (!resp.ok) {
      const text = await resp.text();
      return c.json({ ok: false, error: text }, 500);
    }

    const reader = resp.body?.getReader();
    if (!reader) return c.json({ ok: false, error: 'No response body' }, 500);

    const decoder = new TextDecoder();
    let lastStatus = '';

    // Track cumulative progress across all digests/layers
    const digestProgress = new Map<string, { total: number; completed: number }>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // t114 (U8): a progress line IS the proof the pull is moving. This is the whole fix.
      pullDeadline.bump();
      const text = decoder.decode(value, { stream: true });
      const lines = text.trim().split('\n');

      for (const line of lines) {
        try {
          const json = JSON.parse(line);
          lastStatus = json.status ?? lastStatus;

          if (json.error) {
            currentPullProgress = { model, status: 'error', completed: 0, total: 0, layers: 0, error: json.error };
            return c.json({ ok: false, error: json.error }, 500);
          }

          // Track per-digest progress
          if (json.digest && json.total) {
            digestProgress.set(json.digest, {
              total: json.total,
              completed: json.completed ?? 0,
            });
          }

          // Calculate cumulative totals across all digests
          let cumulativeTotal = 0;
          let cumulativeCompleted = 0;
          for (const [, dp] of digestProgress) {
            cumulativeTotal += dp.total;
            cumulativeCompleted += dp.completed;
          }

          // Update pollable progress state
          currentPullProgress = {
            model,
            status: json.status ?? 'downloading',
            completed: cumulativeCompleted,
            total: cumulativeTotal,
            layers: digestProgress.size,
            error: null,
          };
        } catch { /* skip non-JSON lines */ }
      }
    }

    currentPullProgress = null;
    return c.json({ ok: true, data: { model, pulled: true, status: lastStatus } });
  } catch (err) {
    // t114 (U8): say which bound ended it. "the registry went quiet" is a different problem from
    // "this model is too big to pull", and the old flat wall could not tell them apart.
    if (pullDeadline.fired()) {
      currentPullProgress = {
        model, status: 'error', completed: 0, total: 0, layers: 0,
        error: `the pull stopped making progress for ${Math.round(OLLAMA_PULL_IDLE_MS / 1000)}s and was stopped`,
      };
    }
    return routeFailure(c, logger, err, { status: 500 });
  } finally {
    pullDeadline.done();
  }
});

// DELETE /ollama/models/:name — remove a model
setupDepsRouter.delete('/ollama/models/:name', async (c) => {
  const name = c.req.param('name');
  try {
    const resp = await fetch('http://localhost:11434/api/delete', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name }),
    });
    if (!resp.ok) return c.json({ ok: false, error: 'Failed to delete model' }, 500);
    return c.json({ ok: true, data: { deleted: name } });
  } catch (err) {
    return routeFailure(c, logger, err, { status: 500 });
  }
});

// POST /ollama/auto-configure — create Ollama provider + discover models
setupDepsRouter.post('/ollama/auto-configure', async (c) => {
  const db = getDb();

  // Check if Ollama provider already exists
  const existing = db.prepare("SELECT id FROM providers WHERE type = 'ollama'").get();
  let providerId: string;

  if (existing) {
    providerId = (existing as { id: string }).id;
  } else {
    providerId = 'ollama-local';
    db.prepare(`
      INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, validated_at, created_at, updated_at)
      VALUES (?, 'Ollama (Local)', 'ollama', 'http://localhost:11434', 'none', 1, datetime('now'), datetime('now'), datetime('now'))
    `).run(providerId);
    logger.info('Auto-configured Ollama provider');
  }

  // Discover models
  try {
    const resp = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      const data = await resp.json() as { models?: Array<{ name: string; details?: { parameter_size?: string; family?: string } }> };
      const models = data.models ?? [];
      let added = 0;

      for (const m of models) {
        const modelId = `ollama-${m.name.replace(/[^a-z0-9]/gi, '-')}`;
        const existingModel = db.prepare('SELECT id FROM models WHERE id = ? OR api_model_id = ?').get(modelId, m.name);
        if (!existingModel) {
          db.prepare(`
            INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, input_cost_per_m, output_cost_per_m, is_enabled, created_at, updated_at)
            VALUES (?, ?, ?, ?, '[]', 32000, 0, 0, 1, datetime('now'), datetime('now'))
          `).run(modelId, providerId, m.name, m.name);
          added++;
        }
      }

      logger.info('Ollama model discovery complete', { total: models.length, added });
      return c.json({ ok: true, data: { providerId, modelsFound: models.length, modelsAdded: added } });
    }
  } catch { /* ignore */ }

  return c.json({ ok: true, data: { providerId, modelsFound: 0, modelsAdded: 0 } });
});

// ══════════════════════════════════════
// macOS Permissions
// ══════════════════════════════════════

// GET /permissions/check — check macOS permission statuses
setupDepsRouter.get('/permissions/check', (c) => {
  const checkPermission = (name: string): 'granted' | 'denied' | 'unknown' => {
    try {
      switch (name) {
        case 'screen': {
          // Try screencapture — if it works, permission is granted
          const tmpFile = `/tmp/dojo-screen-check-${Date.now()}.png`;
          try {
            execSync(`screencapture -x -t png ${tmpFile}`, { timeout: 5000, env: execEnv });
            const exists = fs.existsSync(tmpFile);
            try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
            return exists ? 'granted' : 'denied';
          } catch {
            return 'denied';
          }
        }
        case 'accessibility': {
          // Try cliclick — if installed and works, accessibility is granted
          if (!cmdExists('cliclick')) return 'unknown';
          try {
            execSync('cliclick p:.', { timeout: 3000, env: execEnv });
            return 'granted';
          } catch {
            return 'denied';
          }
        }
        case 'full-disk-access': {
          // Try reading Messages database
          const chatDb = path.join(homeDir(), 'Library', 'Messages', 'chat.db');
          try {
            fs.accessSync(chatDb, fs.constants.R_OK);
            return 'granted';
          } catch {
            return 'denied';
          }
        }
        case 'automation': {
          // ── THIS CANNOT BE PROBED WITHOUT SIDE EFFECTS, SO IT IS NOT CLAIMED ──
          //
          // The old probe ran `osascript -e "return 1"`. That script drives NO application, so
          // it needs no Automation grant at all: it succeeded on every box, and this row
          // reported `granted` while sending an iMessage was blocked. A green light on a
          // permission the user does not have is worse than no light — it sends them looking
          // for the fault anywhere but the place it is.
          //
          // There is also no single boolean to report even in principle. macOS grants
          // Automation per (client, target) PAIR, so "is Automation granted?" has as many
          // answers as there are target apps. The only probe that would answer for Messages is
          // an actual AppleEvent to Messages — and that raises a TCC consent dialog on first
          // call. A status endpoint the dashboard polls on mount must not put a modal in front
          // of the user, so that probe is not available here either.
          //
          // So: `unknown`, which this response type already carries (`accessibility` returns it
          // when cliclick is absent), and the dashboard's own copy — `AUTOMATION_VERIFY` — tells
          // the owner the honest test is to send a message and watch it arrive.
          //
          // ⚠ The louder variant — drive Messages for real and read error -1743 as `denied` —
          // answers more and is the OWNER'S CALL, not a worker's, because it trades a status
          // endpoint's silence for a consent dialog (G14). It is recorded on BACKLOG line 75.
          return 'unknown';
        }
        default:
          return 'unknown';
      }
    } catch {
      return 'unknown';
    }
  };

  return c.json({
    ok: true,
    data: {
      screen_recording: checkPermission('screen'),
      accessibility: checkPermission('accessibility'),
      full_disk: checkPermission('full-disk-access'),
      automation: checkPermission('automation'),
      serverExecPath: process.execPath,   // see `@dojo/shared/full-disk-access`
    },
  });
});

// POST /permissions/request/:perm — open system settings for a permission
setupDepsRouter.post('/permissions/request/:perm', (c) => {
  const perm = c.req.param('perm');

  try {
    switch (perm) {
      case 'screen':
        execSync('open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"', { timeout: 5000 });
        break;
      case 'accessibility':
        execSync('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"', { timeout: 5000 });
        break;
      case 'full-disk-access': {
        // First, attempt to read the Messages database — this triggers macOS to register
        // the Node process in the Full Disk Access list (even though it will fail).
        // Without this, the user won't see "node" in the FDA list to toggle on.
        const chatDbPath = path.join(homeDir(), 'Library', 'Messages', 'chat.db');
        try { fs.readFileSync(chatDbPath); } catch { /* expected to fail — the attempt is what registers it */ }
        // Also try via sqlite3 CLI which may register Terminal
        try { execSync(`sqlite3 "${chatDbPath}" "SELECT 1" 2>/dev/null`, { timeout: 3000, env: execEnv }); } catch { /* expected */ }
        execSync('open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"', { timeout: 5000 });
        break;
      }
      case 'automation':
        execSync('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"', { timeout: 5000 });
        break;
      default:
        return c.json({ ok: false, error: `Unknown permission: ${perm}` }, 400);
    }
    return c.json({ ok: true });
  } catch (err) {
    return routeFailure(c, logger, err, { status: 500 });
  }
});

// ══════════════════════════════════════
// Agent Provisioning (OOBE)
// ══════════════════════════════════════

// POST /provision-agent — create or update an agent during OOBE
setupDepsRouter.post('/provision-agent', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.id || !body?.name) {
    return c.json({ ok: false, error: 'id and name are required' }, 400);
  }

  const { id, name, modelId, classification } = body as {
    id: string;
    name: string;
    modelId?: string;
    classification?: string;
  };

  const db = getDb();

  // Check if agent already exists with this ID
  const existing = db.prepare('SELECT id FROM agents WHERE id = ?').get(id);
  if (existing) {
    // Update name and model
    const updates: string[] = ['name = ?', "updated_at = datetime('now')"];
    const params: unknown[] = [name];
    if (modelId) { updates.push('model_id = ?'); params.push(modelId); }
    params.push(id);
    db.prepare(`UPDATE agents SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    logger.info('Agent updated during OOBE', { id, name });
    return c.json({ ok: true, data: { id, name, action: 'updated' } });
  }

  // Remove any old default agents that the migration created
  for (const oldId of ['primary', 'pm']) {
    const old = db.prepare('SELECT id FROM agents WHERE id = ?').get(oldId);
    if (old && oldId !== id) {
      deleteAllForAgent(oldId);
      db.prepare('DELETE FROM agents WHERE id = ?').run(oldId);
      logger.info('Removed placeholder agent', { oldId, newId: id });
    }
  }

  // Create the agent. T11 Step 1b: OOBE provisioning is a person setting the box up.
  db.prepare(`
    INSERT INTO agents (id, name, model_id, system_prompt_path, status, config, created_by, created_by_kind,
                        classification, created_at, updated_at)
    VALUES (?, ?, ?, NULL, 'idle', '{"shareUserProfile":true}', 'system', 'user', ?, datetime('now'), datetime('now'))
  `).run(id, name, modelId ?? null, classification ?? 'sensei');

  logger.info('Agent provisioned during OOBE', { id, name, modelId, classification });
  return c.json({ ok: true, data: { id, name, action: 'created' } });
});
