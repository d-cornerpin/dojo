// Setup routes for the OOBE wizard: dependencies, Ollama models, macOS permissions and agent provisioning.

import { Hono } from 'hono';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { resolveProvision } from './setup-primary-id.js';
import { setPlatformConfig } from '../../config/platform.js';
import { deleteAllForAgent } from '../../memory/message-store.js';
import { noteRouteFailure, routeFailure } from './route-failure.js';
import { homeDir } from '../../home.js';
import { pullOllamaModel, type PullProgress } from '../../services/ollama-pull.js';
import { ensureLocalOllamaProvider, STANDARD_DECISION_MODEL, STANDARD_ROW_STAYS, STANDARD_WRITER_MODEL, isStandardTag } from '../../services/local-standard.js';
import { standardProgressLines, standardState, upkeep } from '../../services/ollama-upkeep.js';
import { isVersionRefusal, plainPullError } from '../../services/ollama-version.js';
import { attachIdleBound } from '../../child-idle-bound.js';
import { automationPermissionStatus } from './automation-probe.js';
import { getOllamaModelInfo } from '../../services/ollama.js';
// The 32K floor for an agent's MAIN model.
import { refuseAgentModel, refuseNonChatModel, refuseSmallMainModel } from '../../agent/main-model-floor.js';
import { localModelFit } from '../../agent/local-model-fit.js';
// A create/rename name must not mint a second agent the case-insensitive lookup cannot tell apart.
import { caseVariantClash, caseVariantClashMessage } from '../../agent/tool-helpers.js';

const logger = createLogger('setup-deps');

export const setupDepsRouter = new Hono();


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

// Dependencies

// GET /deps/check: check all dependencies
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

// POST /deps/install/:dep: install a specific dependency
setupDepsRouter.post('/deps/install/:dep', async (c) => {
  const dep = c.req.param('dep');

  try {
    switch (dep) {
      case 'ollama': {
        if (!cmdExists('brew')) return c.json({ ok: false, error: 'Homebrew required' }, 400);
        // --cask installs the full macOS app (background service, PATH setup); fall back to the formula
        // when the cask fails (headless server).
        try {
          await installIdleBounded('brew install --cask ollama');
        } catch {
          await installIdleBounded('brew install ollama');
        }
        return c.json({ ok: true, data: { installed: true } });
      }
      case 'ollama-start': {
        // The one Ollama upkeep starts what was installed as a kind that lasts, current, with the loaded-model limit.
        void upkeep('setup');
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
        // Global install first (works where the npm prefix is user-writable); on EACCES, point npm at
        // ~/.npm-global and retry, which avoids sudo.
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

// Ollama models

// GET /ollama/models: list installed models
setupDepsRouter.get('/ollama/models', async (c) => {
  try {
    const resp = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return c.json({ ok: false, error: 'Ollama not responding' }, 502);
    const data = await resp.json() as { models?: Array<{ name: string; size: number; details?: { parameter_size?: string } }> };
    return c.json({ ok: true, data: (data.models ?? []).filter((m) => m.name !== STANDARD_DECISION_MODEL.windowTag).map((m) => ({ ...m, protected: isStandardTag(m.name) })) });   // no Remove for the Dojo's own window tag
  } catch (err) {
    return routeFailure(c, logger, err, { status: 502, message: 'Cannot connect to Ollama' });
  }
});

// Pull progress, polled by the wizard.

let currentPullProgress: PullProgress | null = null;

// Installs run under the shared idle bound: a download that keeps printing continues, a stuck one is ended,
// and a ceiling that does not re-arm bounds a runaway. A flat execSync cap would SIGKILL a package manager
// mid-write and leave brew or npm partially installed. It is a spawn because execSync has no per-chunk
// signal to read.
const INSTALL_IDLE_MS = 90_000;
const INSTALL_CEILING_MS = 60 * 60_000;

// Run an installer under an output-idle bound. Throws on failure like execSync, with a message naming which
// bound fired, so each route's own error path reports it.
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

// GET /ollama/pull-progress: poll current pull progress
setupDepsRouter.get('/ollama/pull-progress', (c) => {
  return c.json({ ok: true, data: currentPullProgress });
});

// POST /ollama/pull: pull a model with progress tracking (the bounded pull in services/ollama-pull.ts,
// shared with the standard-models install)
setupDepsRouter.post('/ollama/pull', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.model) return c.json({ ok: false, error: 'model is required' }, 400);

  const model = body.model as string;
  try {
    const pull = () => pullOllamaModel(model, { onProgress: (p) => { currentPullProgress = p; } });
    let outcome = await pull();   // one that needs a newer Ollama: the upkeep makes Ollama newer, then it is pulled again
    const current = !outcome.ok && isVersionRefusal(outcome.error) ? await upkeep('setup', 'newer') : null;
    if (current?.ok) outcome = await pull();
    if (outcome.ok) {
      currentPullProgress = null;
      return c.json({ ok: true, data: { model, pulled: true, status: outcome.status } });
    }
    if (outcome.stalled) return routeFailure(c, logger, new Error(outcome.error), { status: 500 });
    logger.warn('Manual model pull failed', { model, error: outcome.error });
    return c.json({ ok: false, error: plainPullError(outcome.error, current?.line) }, 500);
  } catch (err) {
    return routeFailure(c, logger, err, { status: 500 });
  }
});

// DELETE /ollama/models/:name: remove a model
setupDepsRouter.delete('/ollama/models/:name', async (c) => {
  const name = c.req.param('name');
  if (isStandardTag(name)) return c.json({ ok: false, error: STANDARD_ROW_STAYS }, 409);
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

// GET /ollama/standard: the Dojo's two models: their state, their tags, the install's progress lines
setupDepsRouter.get('/ollama/standard', async (c) => {
  const state = await standardState();
  return c.json({ ok: true, data: { ...state, tags: { decision: STANDARD_DECISION_MODEL.tag, writer: STANDARD_WRITER_MODEL.tag }, lines: standardProgressLines() } });
});

// POST /ollama/standard: install or repair them (the Ollama tile's Repair button), in the background
setupDepsRouter.post('/ollama/standard', (c) => {
  void upkeep('repair');
  return c.json({ ok: true, data: { started: true } });
});

// GET /model-fit/:modelId: would the server accept this model for an agent? The setup steps default to the
// cheapest model that says yes. A probe: it marks and tells nothing.
setupDepsRouter.get('/model-fit/:modelId', async (c) => {
  const modelId = c.req.param('modelId');
  const v = await localModelFit(modelId, 'agent');
  return c.json({ ok: true, data: { refused: (v && !v.unchecked && !v.fits ? v.message : null) ?? refuseNonChatModel(modelId) ?? refuseSmallMainModel(modelId) } });
});

// POST /ollama/auto-configure: create Ollama provider + discover models
setupDepsRouter.post('/ollama/auto-configure', async (c) => {
  const db = getDb();

  // The local Ollama provider row, found or created by the one routine the standard models use too.
  const provider = ensureLocalOllamaProvider();
  if (!provider) return c.json({ ok: false, error: 'Could not configure the local Ollama provider' }, 500);
  const providerId = provider.id;

  try {
    const resp = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      const data = await resp.json() as { models?: Array<{ name: string; details?: { parameter_size?: string; family?: string } }> };
      const models = data.models ?? [];
      let added = 0;

      for (const m of models) {
        if (m.name === STANDARD_DECISION_MODEL.windowTag) continue;   // the Dojo's own window tag, never a model row
        const modelId = `ollama-${m.name.replace(/[^a-z0-9]/gi, '-')}`;
        const existingModel = db.prepare('SELECT id FROM models WHERE id = ? OR api_model_id = ?').get(modelId, m.name);
        if (!existingModel) {
          // Store what Ollama reports about the model; what it does not report is NULL, never a stand-in.
          const info = await getOllamaModelInfo(m.name, 'http://localhost:11434');
          db.prepare(`
            INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, input_cost_per_m, output_cost_per_m, is_enabled, created_at, updated_at)
            VALUES (?, ?, ?, ?, '[]', ?, ?, 0, 0, 1, datetime('now'), datetime('now'))
          `).run(modelId, providerId, m.name, m.name, info?.contextWindow ?? null, info?.maxOutputTokens ?? null);
          added++;
        }
      }

      logger.info('Ollama model discovery complete', { total: models.length, added });
      if (models.some((m) => m.name.startsWith('nomic-embed-text'))) void upkeep('setup');   // Ollama answers and the embedder is in: the pair installs itself
      return c.json({ ok: true, data: { providerId, modelsFound: models.length, modelsAdded: added } });
    }
  } catch { /* ignore */ }

  return c.json({ ok: true, data: { providerId, modelsFound: 0, modelsAdded: 0 } });
});

// macOS permissions

// GET /permissions/check: check macOS permission statuses
setupDepsRouter.get('/permissions/check', async (c) => {
  const checkPermission = (name: string): 'granted' | 'denied' | 'unknown' => {
    try {
      switch (name) {
        case 'screen': {
          // Try screencapture; if it works, permission is granted
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
          // Try cliclick; if installed and works, accessibility is granted
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
      // Not in `checkPermission` because it drives Messages for real: macOS may show a consent dialog and
      // the answer arrives when the user clicks. Mechanism and clocks: ./automation-probe.ts.
      automation: await automationPermissionStatus(),
      serverExecPath: process.execPath,   // see `@dojo/shared/full-disk-access`
    },
  });
});

// POST /permissions/request/:perm: open system settings for a permission
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
        // Reading the Messages database fails, but the attempt registers the Node process in the Full Disk
        // Access list; without it the user would see no "node" entry to toggle on.
        const chatDbPath = path.join(homeDir(), 'Library', 'Messages', 'chat.db');
        try { fs.readFileSync(chatDbPath); } catch { /* expected to fail, the attempt is what registers it */ }
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

// Agent provisioning (OOBE)

// POST /provision-agent: create or update an agent during OOBE
setupDepsRouter.post('/provision-agent', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.id || !body?.name) {
    return c.json({ ok: false, error: 'id and name are required' }, 400);
  }

  const { id: requestedId, name, modelId, classification, primary } = body as { id: string; name: string; modelId?: string; classification?: string; primary?: boolean };

  const db = getDb();

  const { id, placeholders } = resolveProvision(db, requestedId, primary);
  // Check if agent already exists with this ID
  const existing = db.prepare('SELECT id, model_id FROM agents WHERE id = ?').get(id) as { id: string; model_id: string | null } | undefined;

  // This door creates AND renames, so refuse a name that differs from another live agent's name only by
  // capitalisation. Re-running setup to re-capitalise an agent's own name stays allowed.
  const clash = caseVariantClash(name, existing ? id : undefined);
  if (clash) return c.json({ ok: false, error: caseVariantClashMessage(clash.name) }, 400);

  // The 32K floor for an agent's MAIN model, asked before anything is written; re-running setup on the model
  // an existing agent already has is never refused. A local model that will not fit in memory is refused the
  // same way.
  const refused = await refuseAgentModel(modelId, existing?.model_id);
  if (refused) return c.json({ ok: false, error: refused }, 400);

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

  for (const oldId of placeholders) {
    const old = db.prepare('SELECT id FROM agents WHERE id = ?').get(oldId);
    if (old && oldId !== id) {
      deleteAllForAgent(oldId);
      db.prepare('DELETE FROM agents WHERE id = ?').run(oldId);
      logger.info('Removed placeholder agent', { oldId, newId: id });
    }
  }

  // OOBE provisioning is a person setting the box up. The main agent's row and its pointer land together,
  // so it is never, even briefly, an agent the engine does not know as the main one.
  db.transaction(() => {
    db.prepare(`
      INSERT INTO agents (id, name, model_id, system_prompt_path, status, config, created_by, created_by_kind,
                          classification, created_at, updated_at)
      VALUES (?, ?, ?, NULL, 'idle', '{"shareUserProfile":true}', 'system', 'user', ?, datetime('now'), datetime('now'))
    `).run(id, name, modelId ?? null, classification ?? 'sensei');
    if (primary === true) setPlatformConfig('primary_agent_id', id);
  })();

  logger.info('Agent provisioned during OOBE', { id, name, modelId, classification });
  return c.json({ ok: true, data: { id, name, action: 'created' } });
});
