import { getDb } from '../db/connection.js';
import { deleteAllForAgent } from '../memory/message-store.js';
import { createLogger } from '../logger.js';
import { getPrimaryAgentId, getTrainerAgentId, getTrainerAgentName, isTrainerEnabled, isSetupCompleted } from '../config/platform.js';
import { SEND_TO_PEOPLE } from '../agent/sensei-policy.js';
import { googleReadToolDefinitions } from '../google/tools-read.js';
import { microsoftReadToolDefinitions } from '../microsoft/tools-read.js';

// W25: `node:fs`, `node:path`, `node:url`, `uuid`, `insertMessageIfAbsent`,
// `getPrimaryAgentName` and `getOwnerName` all left with the dead reader below. This module
// no longer touches the filesystem or the messages table at all.
const logger = createLogger('trainer-agent');

// ── Trainer Agent System Prompt ──
//
// ⚠ W25 TOMBSTONE — `loadTrainerSoulPrompt` IS DELETED, and so are both of its writes.
//
// It read `templates/TRAINER-SOUL.md`, substituted `{{trainer_agent_name}}` /
// `{{primary_agent_name}}` / `{{owner_name}}` correctly, and wrote the result as a
// `role='system'` message row. `memory/assembler.ts`'s `tailRender` emits only
// `user`/`assistant`/`tool` rows, so EVERY ONE OF THOSE WRITES WAS DEAD ON ARRIVAL — the
// same defect W24 found and deleted in `tracker/pm-agent.ts`, one agent over. Two readers
// of one file name, and the one that did the work fed a store no model can see.
//
// WHERE THE REQUIREMENT NOW LIVES: `prompt/assembler.ts`. `soulFileForAgent` resolves the
// trainer to `~/.dojo/prompts/TRAINER-SOUL.md` with `trainerSoulDefault()` — the shipped
// template, substituted — as its seed, and `reseedUnsubstituted` replaces a stored soul
// that still carries `{{…}}`, which is what reaches a box where the 3,023-byte stub is
// already on disk. That file is the ONE store the runtime (`getSoulContent`) and the
// Settings card (`prompt/agent-prompt-surface.ts`) both read, so "a prompt update actually
// reaches an already-running Trainer" is met by the store rather than by a second writer.
//
// An OWNER-EDITED soul is never re-seeded: an owner's words have no placeholders in them.

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
    logger.warn('Primary agent not yet created, deferring Trainer agent spawn', { primaryId });
    // Retry after a short delay
    setTimeout(() => ensureTrainerAgentRunning(), 5000);
    return;
  }

  const trainer = db.prepare('SELECT id, status FROM agents WHERE id = ?').get(trainerId) as { id: string; status: string } | undefined;

  // FU-4 (owner decision 2026-07-05): the Trainer moves from a whitelist to a
  // DENY-list, like the primary. An EMPTY allow list means it keeps everything
  // its manifest permits (technique tools, file read/write, exec, vault,
  // credentials, web, tracker, history, utility, send_to_agent + in-chat
  // replies), and only the genuinely-dangerous set below is blocked. The whole
  // point of the migration is that a NEW tool no longer silently under-grants the
  // Trainer, so do not reintroduce a hand-maintained allow-list here.
  //
  // The comms-to-people block is derived from the shared SEND_TO_PEOPLE set so a
  // FUTURE comms tool is denied by construction (add it to sensei-policy.ts and
  // this refresh picks it up next boot), not by remembering to edit this list.
  // Several entries below are ALSO stripped/gated for non-primary agents already
  // (PRIMARY_ONLY_TOOLS, the reset_session primary-or-Healer gate, the no-spawn
  // manifest); they are listed for surface honesty and so the deny is the single
  // authoritative statement of what the Trainer cannot do. NO file_delete entry:
  // there is no agent-callable file_delete tool; deletion rides rm-via-exec, held
  // by the destructive gate (FU-4 plan section 4).
  const trainerToolsPolicy = JSON.stringify({
    allow: [],
    deny: [
      // (1) Sending on the owner's comms channels to real people. Shared set so a
      // future comms tool is denied by construction. Keeps send_to_agent + replies.
      ...SEND_TO_PEOPLE,
      // (2) Platform / owner controls (all in PRIMARY_ONLY_TOOLS; redundant-but-honest).
      'apply_update', 'check_for_update',
      'set_capability_model', 'set_channel', 'set_voice', 'set_user_presence',
      'open_settings', 'dashboard_navigate',
      // (3) Managing other agents. update_agent is PRIMARY_ONLY; reset_session is
      // primary-or-Healer gated, this closes it for the Trainer explicitly.
      'update_agent', 'kill_agent', 'reset_session',
      // (4) Spawning its own sub-agents. can_spawn_agents:false already strips
      // spawn_agent/kill_agent from the surface; deny states it authoritatively.
      'spawn_agent',
      // (5) Reading the owner's personal data (owner decision 2026-07-06 night:
      // block the read tier the deny-list migration had surfaced). Derived from
      // the read-tool definition arrays themselves so a FUTURE read tool is
      // denied by construction, the same discipline as SEND_TO_PEOPLE: mail,
      // calendar, drive/onedrive, docs/sheets reads, teams reads. Technique work
      // never needs the owner's inbox; web_search/web_fetch stay granted.
      ...googleReadToolDefinitions.map((t) => t.name),
      ...microsoftReadToolDefinitions.map((t) => t.name),
    ],
  });

  // v2.5.15, Permissions are also defined here (before the early-return path)
  // so the "trainer already exists" branch can refresh them too. Previously
  // permissions were only set on initial create, which meant existing
  // trainers from older versions kept restrictive defaults forever
  // (network_domains:'none' → web_fetch silently stripped by the permission
  // filter even when web_fetch was on the tools_policy.allow list).
  const trainerPermissions = JSON.stringify({
    file_read: '*',
    // FU-4: the owner declined to confine the Trainer's writes to the training
    // folders, so file_write widens from ['~/.dojo/techniques/**'] to '*'. The
    // owner's identity/config files stay protected by the PROTECTED_IDENTITY_PATHS
    // hard-deny in permissions.ts checkPermission (Trainer-scoped), and SOUL /
    // secrets by the existing globals; the destructive gate holds rm-via-exec.
    file_write: '*',
    file_delete: 'none',
    exec_allow: ['*'],
    exec_deny: [],
    network_domains: '*',
    can_spawn_agents: false,
    can_assign_permissions: false,
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
    logger.info('Trainer agent already running, refreshing tools_policy + permissions', { status: trainer.status });
    // v2.5.15, Refresh BOTH tools_policy and permissions on every boot.
    // Previously only tools_policy was refreshed, leaving stale permissions
    // (e.g. network_domains:'none') that silently blocked tools.
    db.prepare("UPDATE agents SET tools_policy = ?, permissions = ?, updated_at = datetime('now') WHERE id = ?")
      .run(trainerToolsPolicy, trainerPermissions, trainerId);
    return;
  }

  // Get Trainer model: check saved setting first, fall back to primary agent's model
  const trainerModelSetting = db.prepare("SELECT value FROM config WHERE key = 'trainer_agent_model'").get() as { value: string } | undefined;
  let modelId: string | null = trainerModelSetting?.value ?? null;
  if (!modelId) {
    const primary = db.prepare('SELECT model_id FROM agents WHERE id = ?').get(primaryId) as { model_id: string | null } | undefined;
    modelId = primary?.model_id ?? null;
  }

  if (trainer) {
    // Trainer exists but was terminated, reactivate
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
    // T11 Step 1b: the Trainer is platform machinery, not a person's agent.
    db.prepare(`
      INSERT INTO agents (id, name, model_id, system_prompt_path, status, config, created_by, created_by_kind,
                          parent_agent, spawn_depth, agent_type, classification, max_runtime, timeout_at,
                          permissions, tools_policy, task_id, created_at, updated_at)
      VALUES (?, ?, ?, NULL, 'idle', '{"shareUserProfile":true}', ?, 'agent',
              ?, 1, 'persistent', 'sensei', NULL, NULL,
              ?, ?, NULL, datetime('now'), datetime('now'))
    `).run(trainerId, trainerName, modelId, primaryId, primaryId, trainerPermissions, trainerToolsPolicy);

    // W25: the dead `role='system'` soul write that stood here is deleted, not moved —
    // see the tombstone at the top of this file.

    logger.info('Trainer agent created', { trainerId, trainerName });
  }
}

// ── Clear Trainer Session ──

export function clearTrainerSession(): void {
  const trainerId = getTrainerAgentId();

  deleteAllForAgent(trainerId);

  // W25: no soul re-injection. The identity is not in this table and never was — it is the
  // `sys.identity` prompt entry, rendered from the soul FILE on every assembly, so a cleared
  // session comes back with its whole doctrine rather than with a row nothing reads.

  logger.info('Trainer session cleared', { trainerId });
}
