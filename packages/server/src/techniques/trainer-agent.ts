import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { getPrimaryAgentId, getPrimaryAgentName, getTrainerAgentId, getTrainerAgentName, isTrainerEnabled, isSetupCompleted, getOwnerName } from '../config/platform.js';

const logger = createLogger('trainer-agent');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Trainer Agent System Prompt ──

function loadTrainerSoulPrompt(): string {
  const trainerName = getTrainerAgentName();
  const primaryName = getPrimaryAgentName();
  const ownerName = getOwnerName();

  // Try loading from templates directory
  const templatePaths = [
    path.resolve(__dirname, '../../../../templates/TRAINER-SOUL.md'),
    path.resolve(__dirname, '../../../templates/TRAINER-SOUL.md'),
  ];

  for (const templatePath of templatePaths) {
    try {
      if (fs.existsSync(templatePath)) {
        let content = fs.readFileSync(templatePath, 'utf-8');
        // Replace template variables
        content = content.replace(/\{\{trainer_agent_name\}\}/g, trainerName);
        content = content.replace(/\{\{primary_agent_name\}\}/g, primaryName);
        content = content.replace(/\{\{owner_name\}\}/g, ownerName);
        return content;
      }
    } catch {
      // Try next path
    }
  }

  // Fallback default
  return `# Identity

You are ${trainerName}, the technique trainer for the DOJO Agent Platform. Your job is to help create, refine, and maintain reusable techniques that all agents in the dojo can learn and use.

# Rules

- Always use the \`save_technique\` tool to create techniques — never just describe them
- Include supporting files (scripts, templates) when they add value
- Choose descriptive, lowercase-hyphenated names for techniques
- Tag techniques accurately for discoverability
- When updating a technique, explain what changed in the change summary
- Keep instructions clear and actionable — other agents need to follow them exactly`;
}

// ── Ensure Trainer Agent Running ──

export function ensureTrainerAgentRunning(): void {
  if (!isTrainerEnabled()) {
    logger.info('Trainer agent is disabled, skipping auto-spawn');
    return;
  }

  if (!isSetupCompleted()) {
    logger.info('Setup not completed, deferring Trainer agent creation to setup wizard');
    return;
  }

  const db = getDb();
  const trainerId = getTrainerAgentId();
  const trainerName = getTrainerAgentName();
  const primaryId = getPrimaryAgentId();

  logger.info('Trainer agent auto-spawn check triggered', { trainerId, trainerName });

  // Ensure the primary agent exists before creating Trainer (parent_agent FK constraint)
  const primaryExists = db.prepare('SELECT id FROM agents WHERE id = ?').get(primaryId);
  if (!primaryExists) {
    logger.warn('Primary agent not yet created — deferring Trainer agent spawn', { primaryId });
    // Retry after a short delay
    setTimeout(() => ensureTrainerAgentRunning(), 5000);
    return;
  }

  const trainer = db.prepare('SELECT id, status FROM agents WHERE id = ?').get(trainerId) as { id: string; status: string } | undefined;

  const trainerToolsPolicy = JSON.stringify({
    allow: [
      'save_technique', 'use_technique', 'list_techniques', 'publish_technique',
      'update_technique', 'submit_technique_for_review',
      'send_to_agent', 'list_agents', 'get_current_time',
      'file_read', 'file_write',
    ],
  });

  // Ensure config settings exist (may be missing if created before setup wizard)
  const configCheck = db.prepare("SELECT value FROM config WHERE key = 'trainer_agent_id'").get();
  if (!configCheck) {
    db.prepare("INSERT OR IGNORE INTO config (key, value, updated_at) VALUES ('trainer_agent_id', ?, datetime('now'))").run(trainerId);
    db.prepare("INSERT OR IGNORE INTO config (key, value, updated_at) VALUES ('trainer_agent_name', ?, datetime('now'))").run(trainerName);
    db.prepare("INSERT OR IGNORE INTO config (key, value, updated_at) VALUES ('trainer_agent_enabled', 'true', datetime('now'))").run();
    logger.info('Wrote missing trainer config settings', { trainerId, trainerName });
  }

  if (trainer && trainer.status !== 'terminated') {
    logger.info('Trainer agent already running', { status: trainer.status });
    // Ensure permissions are up to date on every boot
    db.prepare("UPDATE agents SET tools_policy = ?, updated_at = datetime('now') WHERE id = ?").run(trainerToolsPolicy, trainerId);
    return;
  }

  const systemPrompt = loadTrainerSoulPrompt();

  // Get Trainer model: check saved setting first, fall back to primary agent's model
  const trainerModelSetting = db.prepare("SELECT value FROM config WHERE key = 'trainer_agent_model'").get() as { value: string } | undefined;
  let modelId: string | null = trainerModelSetting?.value ?? null;
  if (!modelId) {
    const primary = db.prepare('SELECT model_id FROM agents WHERE id = ?').get(primaryId) as { model_id: string | null } | undefined;
    modelId = primary?.model_id ?? null;
  }

  const trainerPermissions = JSON.stringify({
    file_read: ['~/.dojo/techniques/**'],
    file_write: ['~/.dojo/techniques/**'],
    file_delete: 'none',
    exec_allow: [],
    exec_deny: ['*'],
    network_domains: 'none',
    can_spawn_agents: false,
    can_assign_permissions: false,
  });

  if (trainer) {
    // Trainer exists but was terminated — reactivate
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
    `).run(trainerName, modelId, primaryId, trainerPermissions, trainerToolsPolicy, trainerId);

    logger.info('Trainer agent reactivated', { trainerId, trainerName });
  } else {
    // Create Trainer agent
    db.prepare(`
      INSERT INTO agents (id, name, model_id, system_prompt_path, status, config, created_by,
                          parent_agent, spawn_depth, agent_type, classification, max_runtime, timeout_at,
                          permissions, tools_policy, task_id, created_at, updated_at)
      VALUES (?, ?, ?, NULL, 'idle', '{"shareUserProfile":true}', ?,
              ?, 1, 'persistent', 'sensei', NULL, NULL,
              ?, ?, NULL, datetime('now'), datetime('now'))
    `).run(trainerId, trainerName, modelId, primaryId, primaryId, trainerPermissions, trainerToolsPolicy);

    db.prepare(`
      INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
      VALUES (?, ?, 'system', ?, datetime('now'))
    `).run(uuidv4(), trainerId, systemPrompt);

    logger.info('Trainer agent created', { trainerId, trainerName });
  }
}

// ── Clear Trainer Session ──

export function clearTrainerSession(): void {
  const db = getDb();
  const trainerId = getTrainerAgentId();

  db.prepare('DELETE FROM messages WHERE agent_id = ?').run(trainerId);

  // Re-inject system prompt so the agent has its identity on next message
  const systemPrompt = loadTrainerSoulPrompt();
  db.prepare(`
    INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
    VALUES (?, ?, 'system', ?, datetime('now'))
  `).run(uuidv4(), trainerId, systemPrompt);

  logger.info('Trainer session cleared', { trainerId });
}
