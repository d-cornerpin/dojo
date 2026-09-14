// ════════════════════════════════════════
// Imaginer System Agent
// ════════════════════════════════════════
//
// Imaginer is a Sensei-tier permanent agent (like the primary agent, PM, Trainer). Its
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

import { getDb } from '../db/connection.js';
import { deleteAllForAgent } from '../memory/message-store.js';
import { createLogger } from '../logger.js';
import {
  getPrimaryAgentId,
  getImaginerAgentId,
  getImaginerAgentName,
  isImaginerEnabled,
  isSetupCompleted,
} from '../config/platform.js';

const logger = createLogger('imaginer-agent');

// ── W42 TOMBSTONE (UX-REPAIR T59): `loadImaginerSoulPrompt` IS GONE, AND SO ARE BOTH WRITES ──
//
// It read `templates/IMAGINER-SOUL.md`, substituted three names with its own private
// `.replace` chain, and wrote the result as a `role='system'` message row — at agent CREATION
// and again in `clearImaginerSession`. `tailRender` emits only user/assistant/tool rows, so
// neither write could reach a model; the only reader was `readStoredCharter`'s legacy sniff,
// and measured at `85537ff` this box's Imaginer has **zero** `role='system'` rows, so
// `GET /api/agents/imaginer/system-prompt` served 0 bytes and the model ran on the synthesized
// sub-agent identity.
//
// THE REQUIREMENT NOW LIVES IN ONE PLACE: `prompt/assembler.ts`'s `soulFileForAgent` declares
// `IMAGINER-SOUL.md` with the shipped template as its seed, and `substitutePlatformNames` —
// the ONE substituter — fills `{{imaginer_agent_name}}` there. Clearing the session no longer
// has an identity to re-insert, which is the point: the identity is not in the session.

// ── Ensure Imaginer running ───────────────────────────────────────────

const IMAGINER_TOOLS_POLICY = JSON.stringify({
  allow: [
    // Core always-on
    'load_tool_docs',
    'complete_task',
    'get_current_time',
    // Imaginer talks back if someone messages it directly. The actual
    // image_create flow is engine-handled — Imaginer's LLM doesn't run
    // for that path, so it doesn't need (and shouldn't have) image tools.
    // 'image_generate_internal' was historically listed here but the tool
    // is not registered in the tool dispatcher — it never worked.
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
    // ⟨RETIRED — UX-ACCESS A1, owner ruling 3⟩ The per-boot rewrite of this
    // agent's `tools_policy` + `permissions` stood here. Census C8: it was one of
    // four sites that overwrote a live row on EVERY restart, which meant an owner
    // edit to this agent was silently reverted — the exact defect ruling 3 names
    // ("the boot rewriter retires so edits stop silently reverting").
    //
    // WHAT STILL HOLDS THE INVARIANT IT WAS PROTECTING. The frozen deny/allow list
    // was never the real wall: a sensei that is not the primary now carries
    // `channels.master = null` and no channel grant at all, so every tool on the
    // build-checked `SEND_TO_PEOPLE` surface is refused AT THE DOOR by
    // `mayUseChannel` — including one added after this boot, which a frozen list
    // of names could never have covered. The declared grants are seeded once, from
    // this row's own values, by `agent/access/materialize.ts`.
    //
    // The CREATE and REACTIVATE paths below still write the policy: those mint a
    // row rather than overwrite a live one, so they revert nobody.
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

    // (No soul row is written here any more — see the W42 tombstone above. The identity is
    // seeded into `~/.dojo/prompts/IMAGINER-SOUL.md` on the first read, by the one door.)
    logger.info('Imaginer agent created', { imaginerId, imaginerName });
  }
}

// ── Clear Imaginer session (mirrors the Trainer helper) ───────────────

export function clearImaginerSession(): void {
  const imaginerId = getImaginerAgentId();

  deleteAllForAgent(imaginerId);

  // The identity is NOT re-inserted: it does not live in the session any more. `soulFileForAgent`
  // resolves `IMAGINER-SOUL.md` on the next read, so a cleared Imaginer wakes with its whole soul
  // instead of the row this function used to plant and nothing used to read.
  logger.info('Imaginer session cleared', { imaginerId });
}
