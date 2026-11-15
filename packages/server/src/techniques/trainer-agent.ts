import { primaryReady } from '../agent/primary-ready.js';
import { getDb } from '../db/connection.js';
import { deleteAllForAgent } from '../memory/message-store.js';
import { createLogger } from '../logger.js';
import { getPrimaryAgentId, getTrainerAgentId, getTrainerAgentName, isSetupCompleted } from '../config/platform.js';
import { SEND_TO_PEOPLE } from '../agent/sensei-policy.js';
import { serviceAgentModelId } from '../agent/main-model-floor.js';
import { googleReadToolDefinitions } from '../google/tools-read.js';
import { microsoftReadToolDefinitions } from '../microsoft/tools-read.js';

const logger = createLogger('trainer-agent');

// No soul message row is written here: a role='system' row never reaches the model (memory/assembler.ts
// tailRender emits only user/assistant/tool). Identity is the soul file (`soulFileForAgent`, prompt/assembler.ts).


export function ensureTrainerAgentRunning(): void {
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
  if (!primaryReady('Trainer agent', primaryId, () => ensureTrainerAgentRunning())) return;

  const trainer = db.prepare('SELECT id, status FROM agents WHERE id = ?').get(trainerId) as { id: string; status: string } | undefined;

  // Deny-list like the primary: an empty allow list keeps everything the manifest permits, so a new tool never
  // under-grants, and only the dangerous set below is blocked (comms derives from SEND_TO_PEOPLE, so a future
  // comms tool is denied by construction).
  const trainerToolsPolicy = JSON.stringify({
    allow: [],
    deny: [
      ...SEND_TO_PEOPLE,
      'apply_update', 'check_for_update',
      'set_capability_model', 'set_channel', 'set_voice', 'set_user_presence',
      'open_settings', 'dashboard_navigate',
      'update_agent', 'kill_agent', 'reset_session',
      'spawn_agent',
      // Owner personal-data reads (mail, calendar, drive, docs, teams), derived from the read-tool definitions so a
      // future read tool is denied by construction. web_search/web_fetch stay granted.
      ...googleReadToolDefinitions.map((t) => t.name),
      ...microsoftReadToolDefinitions.map((t) => t.name),
    ],
  });

  const trainerPermissions = JSON.stringify({
    file_read: '*',
    // file_write is unconfined: agent/brokers/fs.ts denies the Trainer the protected identity paths, and the
    // global write tier in agent/brokers/deny.ts guards secrets.yaml, the database files and the soul files.
    file_write: '*',
    exec_allow: ['*'],
    exec_deny: [],
    network_domains: '*',
    can_spawn_agents: false,
    can_assign_permissions: false,
  });

  const configCheck = db.prepare("SELECT value FROM config WHERE key = 'trainer_agent_id'").get();
  if (!configCheck) {
    db.prepare("INSERT OR IGNORE INTO config (key, value, updated_at) VALUES ('trainer_agent_id', ?, datetime('now'))").run(trainerId);
    db.prepare("INSERT OR IGNORE INTO config (key, value, updated_at) VALUES ('trainer_agent_name', ?, datetime('now'))").run(trainerName);
    logger.info('Wrote missing trainer config settings', { trainerId, trainerName });
  }

  if (trainer && trainer.status !== 'terminated') {
    logger.info('Trainer agent already running, refreshing tools_policy + permissions', { status: trainer.status });
    // A live row is never rewritten on boot, so an owner edit to this agent persists. A non-primary sensei has
    // no master channel grant, so SEND_TO_PEOPLE tools are refused at the door by `mayUseChannel`. The CREATE and
    // REACTIVATE paths below write the policy because they mint a row.
    return;
  }

  const modelId = serviceAgentModelId('trainer_agent_model', primaryId);   // never a model under the floor

  if (trainer) {
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
    db.prepare(`
      INSERT INTO agents (id, name, model_id, system_prompt_path, status, config, created_by, created_by_kind,
                          parent_agent, spawn_depth, agent_type, classification, max_runtime, timeout_at,
                          permissions, tools_policy, task_id, created_at, updated_at)
      VALUES (?, ?, ?, NULL, 'idle', '{"shareUserProfile":true}', ?, 'agent',
              ?, 1, 'persistent', 'sensei', NULL, NULL,
              ?, ?, NULL, datetime('now'), datetime('now'))
    `).run(trainerId, trainerName, modelId, primaryId, primaryId, trainerPermissions, trainerToolsPolicy);


    logger.info('Trainer agent created', { trainerId, trainerName });
  }
}


export function clearTrainerSession(): void {
  const trainerId = getTrainerAgentId();

  deleteAllForAgent(trainerId);

  // No soul re-injection: identity is the `sys.identity` prompt entry, rendered from the soul file on every
  // assembly, so a cleared session comes back with its whole doctrine.

  logger.info('Trainer session cleared', { trainerId });
}
