// ════════════════════════════════════════
// Imaginer System Agent
// ════════════════════════════════════════
//
// Imaginer is a Sensei-tier permanent agent (like Kevin, PM, Trainer). Its
// sole job is handling image generation requests from other agents via the
// `image_create` tool. When an agent calls `image_create`, a message is
// routed to Imaginer containing the description + metadata. Imaginer
// acknowledges, crafts a prompt, calls its dedicated `image_generate_internal`
// tool, and sends the finished image back to the requesting agent via
// `send_to_agent`.
//
// Imaginer uses a TEXT model for orchestration (its "brain") — whatever the
// primary agent uses by default, or an explicit override saved as
// `imaginer_brain_model` in the config table.
//
// The IMAGE generation model is a SEPARATE config value stored as
// `imaginer_image_model`. The `image_generate_internal` tool reads that
// value and calls the image generation service. This separation means
// Imaginer's chat-level reasoning can use any capable text model, while
// the actual image-producing model is picked from the image_generation
// capability list in Settings → Dojo → Imaginer.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import {
  getPrimaryAgentId,
  getPrimaryAgentName,
  getImaginerAgentId,
  getImaginerAgentName,
  isImaginerEnabled,
  isSetupCompleted,
  getOwnerName,
} from '../config/platform.js';

const logger = createLogger('imaginer-agent');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── System prompt ─────────────────────────────────────────────────────

function loadImaginerSoulPrompt(): string {
  const imaginerName = getImaginerAgentName();
  const primaryName = getPrimaryAgentName();
  const ownerName = getOwnerName();

  const templatePaths = [
    path.resolve(__dirname, '../../../../templates/IMAGINER-SOUL.md'),
    path.resolve(__dirname, '../../../templates/IMAGINER-SOUL.md'),
  ];

  for (const templatePath of templatePaths) {
    try {
      if (fs.existsSync(templatePath)) {
        let content = fs.readFileSync(templatePath, 'utf-8');
        content = content.replace(/\{\{imaginer_agent_name\}\}/g, imaginerName);
        content = content.replace(/\{\{primary_agent_name\}\}/g, primaryName);
        content = content.replace(/\{\{owner_name\}\}/g, ownerName);
        return content;
      }
    } catch { /* try next path */ }
  }

  // Minimal fallback — production always has the template
  return `You are ${imaginerName}, the dojo's image generation specialist. When you receive an image_create request from another agent, (1) send them an immediate ack via send_to_agent, (2) craft a great prompt, (3) call image_generate_internal with the prompt + aspect ratio, (4) send the file path back via send_to_agent. Never skip the ack, never chat, never refuse reasonable requests. You are invisible infrastructure.`;
}

// ── Ensure Imaginer running ───────────────────────────────────────────

const IMAGINER_TOOLS_POLICY = JSON.stringify({
  allow: [
    // Core always-on
    'load_tool_docs',
    'complete_task',
    'get_current_time',
    // Imaginer's two actual jobs
    'image_generate_internal',
    'send_to_agent',
    // Occasionally useful
    'list_agents',
  ],
});

const IMAGINER_PERMISSIONS = JSON.stringify({
  file_read: ['~/.dojo/uploads/generated/**'],
  file_write: ['~/.dojo/uploads/generated/**'],
  file_delete: 'none',
  exec_allow: [],
  exec_deny: ['*'],
  network_domains: 'none',
  can_spawn_agents: false,
  can_assign_permissions: false,
});

export function ensureImaginerAgentRunning(): void {
  if (!isImaginerEnabled()) {
    logger.info('Imaginer is disabled, skipping auto-spawn');
    return;
  }
  if (!isSetupCompleted()) {
    logger.info('Setup not completed, deferring Imaginer creation');
    return;
  }

  const db = getDb();
  const imaginerId = getImaginerAgentId();
  const imaginerName = getImaginerAgentName();
  const primaryId = getPrimaryAgentId();

  logger.info('Imaginer auto-spawn check triggered', { imaginerId, imaginerName });

  // Can't create before the primary agent exists — parent_agent FK.
  const primaryExists = db.prepare('SELECT id FROM agents WHERE id = ?').get(primaryId);
  if (!primaryExists) {
    logger.warn('Primary agent not yet created — deferring Imaginer spawn', { primaryId });
    setTimeout(() => ensureImaginerAgentRunning(), 5000);
    return;
  }

  const existing = db.prepare('SELECT id, status FROM agents WHERE id = ?').get(imaginerId) as
    | { id: string; status: string }
    | undefined;

  // Ensure the three config keys exist so helpers have stable values to read
  const configCheck = db.prepare("SELECT value FROM config WHERE key = 'imaginer_agent_id'").get();
  if (!configCheck) {
    db.prepare("INSERT OR IGNORE INTO config (key, value, updated_at) VALUES ('imaginer_agent_id', ?, datetime('now'))").run(imaginerId);
    db.prepare("INSERT OR IGNORE INTO config (key, value, updated_at) VALUES ('imaginer_agent_name', ?, datetime('now'))").run(imaginerName);
    db.prepare("INSERT OR IGNORE INTO config (key, value, updated_at) VALUES ('imaginer_enabled', 'true', datetime('now'))").run();
    logger.info('Wrote missing imaginer config settings', { imaginerId, imaginerName });
  }

  if (existing && existing.status !== 'terminated') {
    logger.info('Imaginer agent already running', { status: existing.status });
    // Keep tools policy and permissions current on every boot
    db.prepare(
      "UPDATE agents SET tools_policy = ?, permissions = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(IMAGINER_TOOLS_POLICY, IMAGINER_PERMISSIONS, imaginerId);
    return;
  }

  // Imaginer's brain model: explicit override if set, else primary agent's model.
  const brainModelRow = db.prepare(
    "SELECT value FROM config WHERE key = 'imaginer_brain_model'",
  ).get() as { value: string } | undefined;
  let brainModelId: string | null = brainModelRow?.value ?? null;
  if (!brainModelId) {
    const primary = db.prepare('SELECT model_id FROM agents WHERE id = ?').get(primaryId) as
      | { model_id: string | null }
      | undefined;
    brainModelId = primary?.model_id ?? null;
  }

  const systemPrompt = loadImaginerSoulPrompt();

  if (existing) {
    // Reactivating from terminated
    db.prepare(`
      UPDATE agents SET
        name = ?,
        model_id = ?,
        status = 'idle',
        agent_type = 'persistent',
        parent_agent = ?,
        spawn_depth = 1,
        max_runtime = NULL,
        timeout_at = NULL,
        permissions = ?,
        tools_policy = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(imaginerName, brainModelId, primaryId, IMAGINER_PERMISSIONS, IMAGINER_TOOLS_POLICY, imaginerId);
    logger.info('Imaginer agent reactivated', { imaginerId, imaginerName });
  } else {
    db.prepare(`
      INSERT OR IGNORE INTO agents (id, name, model_id, system_prompt_path, status, config, created_by,
                          parent_agent, spawn_depth, agent_type, classification, max_runtime, timeout_at,
                          permissions, tools_policy, task_id, created_at, updated_at)
      VALUES (?, ?, ?, NULL, 'idle', '{"shareUserProfile":false}', ?,
              ?, 1, 'persistent', 'sensei', NULL, NULL,
              ?, ?, NULL, datetime('now'), datetime('now'))
    `).run(
      imaginerId,
      imaginerName,
      brainModelId,
      primaryId,
      primaryId,
      IMAGINER_PERMISSIONS,
      IMAGINER_TOOLS_POLICY,
    );

    db.prepare(`
      INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
      VALUES (?, ?, 'system', ?, datetime('now'))
    `).run(uuidv4(), imaginerId, systemPrompt);

    logger.info('Imaginer agent created', { imaginerId, imaginerName });
  }
}

// ── Clear Imaginer session (mirrors the Trainer helper) ───────────────

export function clearImaginerSession(): void {
  const db = getDb();
  const imaginerId = getImaginerAgentId();

  db.prepare('DELETE FROM messages WHERE agent_id = ?').run(imaginerId);

  const systemPrompt = loadImaginerSoulPrompt();
  db.prepare(`
    INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
    VALUES (?, ?, 'system', ?, datetime('now'))
  `).run(uuidv4(), imaginerId, systemPrompt);

  logger.info('Imaginer session cleared', { imaginerId });
}
