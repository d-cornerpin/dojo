// ════════════════════════════════════════
// Vault Maintenance: Dreaming Cycle
// Spawns a temporary "Dreamer" agent to process vault conversations,
// extract knowledge, identify techniques, and maintain the vault.
// Engine-level pruning runs before the Dreamer is spawned.
// ════════════════════════════════════════

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { spawnAgent } from '../agent/spawner.js';
import { getAgentRuntime } from '../agent/runtime.js';
import {
  getPrimaryAgentId,
  getTrainerAgentId, getTrainerAgentName,
  getDreamerAgentId, getDreamerAgentName,
  isSetupCompleted,
} from '../config/platform.js';
import type { Message } from '@dojo/shared';
import { v4 as uuidv4 } from 'uuid';
import {
  getUnprocessedConversations,
  getVaultStats,
  type VaultConversation,
} from './store.js';
import { MAX_PINNED_ENTRIES } from './retrieval.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const logger = createLogger('vault-dreaming');

export type DreamMode = 'full' | 'light' | 'off';

// ── Dreaming Config ──

export function getDreamingConfig(): { modelId: string | null; dreamTime: string; dreamMode: DreamMode } {
  const db = getDb();

  const modelRow = db.prepare("SELECT value FROM config WHERE key = 'dreaming_model_id'").get() as { value: string } | undefined;
  const timeRow = db.prepare("SELECT value FROM config WHERE key = 'dreaming_time'").get() as { value: string } | undefined;
  const modeRow = db.prepare("SELECT value FROM config WHERE key = 'dreaming_mode'").get() as { value: string } | undefined;

  return {
    modelId: modelRow?.value ?? null,
    dreamTime: timeRow?.value ?? '03:00',
    dreamMode: (modeRow?.value as DreamMode) ?? 'full',
  };
}

export function setDreamingConfig(config: { modelId?: string; dreamTime?: string; dreamMode?: DreamMode }): void {
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `);

  if (config.modelId !== undefined) {
    upsert.run('dreaming_model_id', config.modelId, config.modelId);
  }
  if (config.dreamTime !== undefined) {
    upsert.run('dreaming_time', config.dreamTime, config.dreamTime);
  }
  if (config.dreamMode !== undefined) {
    upsert.run('dreaming_mode', config.dreamMode, config.dreamMode);
  }
}

// ── Get Default Model for Dreaming ──

function getDefaultDreamModel(): string | null {
  const db = getDb();
  const model = db.prepare(`
    SELECT id FROM models WHERE is_enabled = 1
    ORDER BY
      CASE WHEN api_model_id LIKE '%sonnet%' THEN 0
           WHEN api_model_id LIKE '%gpt-4o%' THEN 1
           ELSE 2 END,
      input_cost_per_m ASC
    LIMIT 1
  `).get() as { id: string } | undefined;
  return model?.id ?? null;
}

// ── Engine-Level Maintenance (no LLM needed) ──

function runEngineMaintenance(): { pruned: number; decayed: number } {
  const db = getDb();
  let pruned = 0;

  // Hard delete entries with confidence < 0.1
  const hardDeleted = db.prepare(
    'DELETE FROM vault_entries WHERE confidence < 0.1 AND is_obsolete = 0 AND is_pinned = 0 AND is_permanent = 0'
  ).run();
  pruned += hardDeleted.changes;

  // Mark obsolete: confidence < 0.5, never retrieved, older than 7 days
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const lowConfidence = db.prepare(
    'UPDATE vault_entries SET is_obsolete = 1, updated_at = datetime(\'now\') WHERE confidence < 0.5 AND retrieval_count = 0 AND created_at < ? AND is_obsolete = 0 AND is_pinned = 0 AND is_permanent = 0'
  ).run(sevenDaysAgo);
  pruned += lowConfidence.changes;

  // Decay confidence: not retrieved in 30 days, not pinned, not permanent
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const decayResult = db.prepare(`
    UPDATE vault_entries SET confidence = MAX(0, confidence - 0.1), updated_at = datetime('now')
    WHERE is_obsolete = 0 AND is_pinned = 0 AND is_permanent = 0
      AND (last_retrieved_at IS NULL OR last_retrieved_at < ?)
      AND created_at < ?
  `).run(thirtyDaysAgo, thirtyDaysAgo);

  if (pruned > 0) logger.info(`Engine maintenance: pruned ${pruned} low-value vault entries`);
  if (decayResult.changes > 0) logger.info(`Engine maintenance: decayed confidence on ${decayResult.changes} entries`);

  return { pruned, decayed: decayResult.changes };
}

// Rough token estimate: ~4 characters per token
const CHARS_PER_TOKEN = 4;

// Reserve this much of the context window for system prompt, tools, and response
const CONTEXT_OVERHEAD_TOKENS = 8000;

function formatArchive(conv: VaultConversation): string | null {
  let parsedMessages: Array<{ role: string; content: string; createdAt?: string }>;
  try {
    parsedMessages = JSON.parse(conv.messages);
  } catch {
    return null;
  }

  const formatted = parsedMessages.map(m => {
    const role = (m.role ?? 'unknown').toUpperCase();
    const ts = m.createdAt ? ` [${m.createdAt}]` : '';
    return `[${role}${ts}] ${m.content}`;
  }).join('\n\n');

  return `=== ARCHIVE: ${conv.agentName ?? conv.agentId} (ID: ${conv.id}) ===
${conv.messageCount} messages, ${conv.earliestAt} to ${conv.latestAt}

${formatted}

=== END ARCHIVE ===`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Batch archives into chunks that fit within the model's context window.
 * Returns array of batches, each containing the archive IDs and formatted text.
 */
function batchArchives(unprocessed: VaultConversation[], contextWindow: number): Array<{ ids: string[]; text: string }> {
  const budgetTokens = contextWindow - CONTEXT_OVERHEAD_TOKENS;
  const batches: Array<{ ids: string[]; text: string }> = [];

  let currentIds: string[] = [];
  let currentTexts: string[] = [];
  let currentTokens = 0;

  for (const conv of unprocessed) {
    const formatted = formatArchive(conv);
    if (!formatted) continue;

    const archiveTokens = estimateTokens(formatted);

    // If a single archive exceeds the budget, truncate it to fit
    if (archiveTokens > budgetTokens) {
      // Flush current batch first
      if (currentTexts.length > 0) {
        batches.push({ ids: [...currentIds], text: currentTexts.join('\n\n') });
        currentIds = [];
        currentTexts = [];
        currentTokens = 0;
      }

      const maxChars = budgetTokens * CHARS_PER_TOKEN;
      const truncated = formatted.slice(0, maxChars) + '\n\n[TRUNCATED — archive too large for single batch]';
      batches.push({ ids: [conv.id], text: truncated });
      logger.warn('Archive truncated to fit context window', {
        archiveId: conv.id,
        originalTokens: archiveTokens,
        budgetTokens,
      });
      continue;
    }

    // If adding this archive would exceed the budget, flush and start new batch
    if (currentTokens + archiveTokens > budgetTokens && currentTexts.length > 0) {
      batches.push({ ids: [...currentIds], text: currentTexts.join('\n\n') });
      currentIds = [];
      currentTexts = [];
      currentTokens = 0;
    }

    currentIds.push(conv.id);
    currentTexts.push(formatted);
    currentTokens += archiveTokens;
  }

  // Flush remaining
  if (currentTexts.length > 0) {
    batches.push({ ids: [...currentIds], text: currentTexts.join('\n\n') });
  }

  return batches;
}

function buildDreamerInitialMessage(batchText: string, batchIndex: number, totalBatches: number): string {
  const batchNote = totalBatches > 1
    ? `\n\nNote: This is batch ${batchIndex + 1} of ${totalBatches}. Focus on these archives only. More batches will be processed after you finish.\n`
    : '';

  return `Here are the conversation archives to process. Extract all knowledge into the vault using vault_remember, then call complete_task when done.${batchNote}

${batchText}

Begin by creating a tracker project, then process each archive systematically.`;
}

/**
 * Build the cycle message sent to the permanent Dreamer agent.
 * This replaces the old dynamic system prompt — vault state and archive data
 * go in the user message since the system prompt is now fixed.
 */
function buildDreamerCycleMessage(
  batchText: string,
  batchIndex: number,
  totalBatches: number,
  stats: ReturnType<typeof getVaultStats>,
  profilePath: string,
  soulPath: string,
  dreamMode: DreamMode,
  allUnprocessed: VaultConversation[],
): string {
  const trainerName = getTrainerAgentName();
  const trainerId = getTrainerAgentId();
  const techniqueNote = dreamMode === 'full'
    ? `\n- If a conversation shows a reusable multi-step procedure, send it to Trainer agent (${trainerName}, ID: ${trainerId}) via send_to_agent.`
    : '';

  const batchNote = totalBatches > 1
    ? `\n\nThis is batch ${batchIndex + 1} of ${totalBatches}. Focus on these archives only. The remaining batches will be delivered after you call complete_task.`
    : '';

  const archiveSummary = allUnprocessed.length > 0
    ? `\n\nFull archive list (${allUnprocessed.length} total):\n` + allUnprocessed.map((conv, i) =>
        `  ${i + 1}. ${conv.agentName ?? conv.agentId} — ${conv.messageCount} messages (${conv.earliestAt} to ${conv.latestAt})`
      ).join('\n')
    : '';

  return `═══ DREAM CYCLE ═══
Files:
- USER.md: ${profilePath}
- SOUL.md: ${soulPath}

Vault state: ${stats.totalEntries} entries (${stats.pinnedCount} pinned, ${stats.permanentCount} permanent). Pin cap: ${MAX_PINNED_ENTRIES}${stats.pinnedCount > MAX_PINNED_ENTRIES ? ' — OVER CAP, prune now' : ''}.${archiveSummary}${techniqueNote}${batchNote}

Process the archives below. Extract vault memories, update USER.md/SOUL.md if needed, then call complete_task.

${batchText}`;
}

// ── Permanent Dreamer Tools & Permissions ──

const DREAMER_TOOLS_POLICY = JSON.stringify({
  allow: [
    'vault_remember', 'vault_search', 'vault_forget',
    'memory_grep', 'memory_search', 'memory_describe',
    'file_read', 'file_write',
    'tracker_create_project', 'tracker_create_task',
    'tracker_update_status', 'tracker_add_notes', 'tracker_complete_step',
    'tracker_list_projects',
    'send_to_agent', 'list_agents',
    'get_current_time', 'load_tool_docs', 'complete_task',
  ],
});

function getDreamerPermissions(): string {
  const profilePath = path.join(os.homedir(), '.dojo', 'prompts', 'USER.md');
  const soulPath = path.join(os.homedir(), '.dojo', 'prompts', 'SOUL.md');
  return JSON.stringify({
    file_read: [profilePath, soulPath],
    file_write: [profilePath, soulPath],
    file_delete: 'none',
    exec_allow: [],
    exec_deny: ['*'],
    network_domains: 'none',
    max_processes: 0,
    can_spawn_agents: false,
    can_assign_permissions: false,
    system_control: [],
  });
}

function loadDreamerSoulPrompt(): string {
  const templatePaths = [
    path.resolve(__dirname, '../../../../templates/DREAMER-SOUL.md'),
    path.resolve(__dirname, '../../../templates/DREAMER-SOUL.md'),
  ];
  for (const p of templatePaths) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
    } catch { /* try next */ }
  }
  return `You are the Dreamer, the dojo's memory keeper. Each night you process conversation archives into vault memories and keep USER.md and SOUL.md up to date. When done with each cycle, call complete_task.`;
}

export function ensureDreamerAgentRunning(): void {
  if (!isSetupCompleted()) {
    logger.info('Setup not completed, deferring Dreamer creation');
    return;
  }

  const db = getDb();
  const dreamerId = getDreamerAgentId();
  const dreamerName = getDreamerAgentName();
  const primaryId = getPrimaryAgentId();

  logger.info('Dreamer auto-spawn check triggered', { dreamerId, dreamerName });

  const primaryExists = db.prepare('SELECT id FROM agents WHERE id = ?').get(primaryId);
  if (!primaryExists) {
    logger.warn('Primary agent not yet created — deferring Dreamer spawn', { primaryId });
    setTimeout(() => ensureDreamerAgentRunning(), 5000);
    return;
  }

  const existing = db.prepare('SELECT id, status FROM agents WHERE id = ?').get(dreamerId) as
    | { id: string; status: string }
    | undefined;

  const dreamerPermissions = getDreamerPermissions();

  if (existing && existing.status !== 'terminated') {
    logger.info('Dreamer agent already running', { status: existing.status });
    db.prepare(
      "UPDATE agents SET tools_policy = ?, permissions = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(DREAMER_TOOLS_POLICY, dreamerPermissions, dreamerId);
    return;
  }

  // Resolve model: dreaming_model_id, else primary agent's model
  const modelRow = db.prepare("SELECT value FROM config WHERE key = 'dreaming_model_id'").get() as { value: string } | undefined;
  let modelId: string | null = modelRow?.value ?? null;
  if (!modelId) {
    const primary = db.prepare('SELECT model_id FROM agents WHERE id = ?').get(primaryId) as
      | { model_id: string | null }
      | undefined;
    modelId = primary?.model_id ?? null;
  }

  const systemPrompt = loadDreamerSoulPrompt();

  if (existing) {
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
        config = '{"persist":true,"shareUserProfile":false}',
        updated_at = datetime('now')
      WHERE id = ?
    `).run(dreamerName, modelId, primaryId, dreamerPermissions, DREAMER_TOOLS_POLICY, dreamerId);
    logger.info('Dreamer agent reactivated', { dreamerId, dreamerName });
  } else {
    db.prepare(`
      INSERT OR IGNORE INTO agents (id, name, model_id, system_prompt_path, status, config, created_by,
                          parent_agent, spawn_depth, agent_type, classification, max_runtime, timeout_at,
                          permissions, tools_policy, task_id, created_at, updated_at)
      VALUES (?, ?, ?, NULL, 'idle', '{"persist":true,"shareUserProfile":false}', ?,
              ?, 1, 'persistent', 'sensei', NULL, NULL,
              ?, ?, NULL, datetime('now'), datetime('now'))
    `).run(dreamerId, dreamerName, modelId, primaryId, primaryId, dreamerPermissions, DREAMER_TOOLS_POLICY);

    db.prepare(`
      INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
      VALUES (?, ?, 'system', ?, datetime('now'))
    `).run(uuidv4(), dreamerId, systemPrompt);

    logger.info('Dreamer agent created', { dreamerId, dreamerName });
  }
}

// ── Inject Cycle Message and Wake Dreamer ──

function wakeupDreamer(cycleMessage: string): void {
  const db = getDb();
  const dreamerId = getDreamerAgentId();

  const msgId = uuidv4();
  db.prepare(`
    INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
    VALUES (?, ?, 'user', ?, datetime('now'))
  `).run(msgId, dreamerId, cycleMessage);

  broadcast({
    type: 'chat:message',
    agentId: dreamerId,
    message: {
      id: msgId,
      agentId: dreamerId,
      role: 'user' as Message['role'],
      content: cycleMessage,
      tokenCount: null,
      modelId: null,
      cost: null,
      latencyMs: null,
      createdAt: new Date().toISOString(),
    },
  });

  const runtime = getAgentRuntime();
  runtime.handleMessage(dreamerId, cycleMessage).catch(err => {
    logger.error('Dreamer cycle failed', {
      error: err instanceof Error ? err.message : String(err),
    }, dreamerId);
  });
}

// ── Main Dreaming Cycle ──

export async function runDreamingCycle(): Promise<{ dreamerId: string | null }> {
  const config = getDreamingConfig();

  if (config.dreamMode === 'off') {
    logger.info('Dreaming is disabled, skipping cycle');
    return { dreamerId: null };
  }

  const modelId = config.modelId ?? getDefaultDreamModel();
  if (!modelId) {
    logger.warn('No model available for dreaming cycle');
    return { dreamerId: null };
  }

  const primaryId = getPrimaryAgentId();
  if (!primaryId) {
    logger.warn('No primary agent found, cannot spawn Dreamer');
    return { dreamerId: null };
  }

  // Compute profile file paths for Dreamer's file access
  const profilePath = path.join(os.homedir(), '.dojo', 'prompts', 'USER.md');
  const soulPath = path.join(os.homedir(), '.dojo', 'prompts', 'SOUL.md');

  // Step 1: Engine-level maintenance (no LLM, fast)
  const maintenance = runEngineMaintenance();
  logger.info('Engine maintenance complete', maintenance);

  // Step 2: Check for unprocessed archives
  const unprocessed = getUnprocessedConversations();
  if (unprocessed.length === 0) {
    logger.info('No unprocessed conversation archives, skipping Dreamer spawn');
    broadcast({ type: 'dream:complete', data: { skipped: true, reason: 'no_archives', ...maintenance } } as never);
    return { dreamerId: null };
  }

  // Get model context window for batching
  const db = getDb();
  const modelRow = db.prepare('SELECT context_window FROM models WHERE id = ?').get(modelId) as { context_window: number } | undefined;
  const contextWindow = modelRow?.context_window ?? 32000; // conservative default

  // Batch archives to fit within the model's context window
  const batches = batchArchives(unprocessed, contextWindow);

  logger.info(`Waking Dreamer to process ${unprocessed.length} archives in ${batches.length} batch(es)`, {
    mode: config.dreamMode,
    modelId,
    contextWindow,
    batches: batches.length,
  });

  broadcast({ type: 'dream:started', data: { mode: config.dreamMode, archives: unprocessed.length, batches: batches.length } } as never);

  const stats = getVaultStats();

  // Step 3: Process batches — wake Dreamer for the first batch
  // Subsequent batches are handled after each complete_task via markDreamerArchivesProcessed
  const firstBatch = batches[0];
  if (!firstBatch) {
    logger.warn('No valid archive batches to process');
    return { dreamerId: null };
  }

  // Ensure permanent Dreamer exists before waking it
  ensureDreamerAgentRunning();

  const dreamerId = getDreamerAgentId();
  const dreamerState = db.prepare('SELECT status FROM agents WHERE id = ?').get(dreamerId) as { status: string } | undefined;

  if (dreamerState?.status === 'working') {
    logger.warn('Dreamer is already running — skipping cycle');
    return { dreamerId };
  }

  // Store remaining batches for sequential processing
  pendingBatches.set(primaryId, { batches, currentIndex: 0, config, primaryId, modelId, stats });

  // Store the first batch's archive IDs on the Dreamer agent record
  db.prepare(`
    UPDATE agents SET config = json_set(COALESCE(config, '{}'), '$.dreamerArchiveIds', ?)
    WHERE id = ?
  `).run(JSON.stringify(firstBatch.ids), dreamerId);

  // Build cycle message: vault state + archives + instructions
  const cycleMessage = buildDreamerCycleMessage(firstBatch.text, 0, batches.length, stats, profilePath, soulPath, config.dreamMode, unprocessed);

  wakeupDreamer(cycleMessage);

  logger.info('Dreamer agent woken', {
    dreamerId,
    batch: `1/${batches.length}`,
    archivesInBatch: firstBatch.ids.length,
    totalArchives: unprocessed.length,
  });

  return { dreamerId };
}

// ── Batch Processing State ──

interface PendingBatchState {
  batches: Array<{ ids: string[]; text: string }>;
  currentIndex: number;
  config: ReturnType<typeof getDreamingConfig>;
  primaryId: string;
  modelId: string;
  stats: ReturnType<typeof getVaultStats>;
}

const pendingBatches = new Map<string, PendingBatchState>();

/**
 * After the Dreamer completes a batch, check if there are more batches to process.
 * If so, inject the next batch message and wake the permanent Dreamer again.
 */
export async function spawnNextDreamerBatch(primaryId: string): Promise<void> {
  const state = pendingBatches.get(primaryId);
  if (!state) return;

  const nextIndex = state.currentIndex + 1;
  if (nextIndex >= state.batches.length) {
    // All batches done
    pendingBatches.delete(primaryId);
    logger.info('All Dreamer batches complete', { totalBatches: state.batches.length });
    broadcast({ type: 'dream:complete', data: { batches: state.batches.length } } as never);
    return;
  }

  state.currentIndex = nextIndex;
  const batch = state.batches[nextIndex];

  logger.info(`Injecting next Dreamer batch ${nextIndex + 1}/${state.batches.length}`, {
    archivesInBatch: batch.ids.length,
  });

  const osModule = await import('node:os');
  const pathModule = await import('node:path');
  const profilePath = pathModule.join(osModule.homedir(), '.dojo', 'prompts', 'USER.md');
  const soulPath = pathModule.join(osModule.homedir(), '.dojo', 'prompts', 'SOUL.md');

  try {
    const dreamerId = getDreamerAgentId();
    const db = getDb();

    // Update archive IDs on the permanent Dreamer record for this batch
    db.prepare(`
      UPDATE agents SET config = json_set(COALESCE(config, '{}'), '$.dreamerArchiveIds', ?)
      WHERE id = ?
    `).run(JSON.stringify(batch.ids), dreamerId);

    const nextCycleMessage = buildDreamerCycleMessage(
      batch.text,
      nextIndex,
      state.batches.length,
      state.stats,
      profilePath,
      soulPath,
      state.config.dreamMode,
      [],
    );

    wakeupDreamer(nextCycleMessage);

    logger.info('Dreamer woken for next batch', {
      dreamerId,
      batch: `${nextIndex + 1}/${state.batches.length}`,
    });
  } catch (err) {
    logger.error('Failed to wake Dreamer for next batch', {
      error: err instanceof Error ? err.message : String(err),
      batch: `${nextIndex + 1}/${state.batches.length}`,
    });
    pendingBatches.delete(primaryId);
  }
}

// ── Mark Dreamer Archives as Processed ──

/**
 * Called when the Dreamer agent completes a batch. Marks all assigned archives as
 * processed, then wakes the Dreamer for the next batch if there are more.
 *
 * dreamerAgentId may be either the permanent 'dreamer' ID or a legacy temporary agent ID.
 */
export function markDreamerArchivesProcessed(dreamerAgentId: string): void {
  const db = getDb();

  // For the permanent Dreamer, archive IDs are always on the fixed Dreamer agent record.
  // For legacy temporary agents (first-run bootstrap, etc.), fall back to the passed ID.
  const permanentDreamerId = getDreamerAgentId();
  const lookupId = dreamerAgentId === permanentDreamerId ? permanentDreamerId : dreamerAgentId;

  const agent = db.prepare('SELECT config, parent_agent FROM agents WHERE id = ?').get(lookupId) as
    | { config: string; parent_agent: string | null }
    | undefined;
  if (!agent) return;

  try {
    const config = JSON.parse(agent.config || '{}');
    const archiveIds = config.dreamerArchiveIds as string[] | undefined;
    if (!archiveIds || archiveIds.length === 0) return;

    for (const id of archiveIds) {
      db.prepare("UPDATE vault_conversations SET is_processed = 1, processed_at = datetime('now') WHERE id = ?").run(id);
    }

    logger.info(`Marked ${archiveIds.length} archives as processed after Dreamer completion`, { dreamerAgentId });

    // Check if there are more batches to process
    const primaryId = agent.parent_agent;
    if (primaryId) {
      spawnNextDreamerBatch(primaryId).catch(err => {
        logger.error('Failed to wake Dreamer for next batch', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  } catch {
    // Best effort
  }
}

// ── First-Run Profile Bootstrap ──

/**
 * After the setup wizard completes, spawn a Dreamer to process the user's
 * "About You" profile (USER.md). The Dreamer extracts long-term facts into
 * the vault and trims the profile down to only what's needed every turn.
 */
export async function runFirstRunProfileBootstrap(): Promise<{ dreamerId: string | null }> {
  const config = getDreamingConfig();
  const modelId = config.modelId ?? getDefaultDreamModel();
  if (!modelId) {
    logger.warn('No model available for first-run profile bootstrap');
    return { dreamerId: null };
  }

  const primaryId = getPrimaryAgentId();
  if (!primaryId) {
    logger.warn('No primary agent found for first-run profile bootstrap');
    return { dreamerId: null };
  }

  // Read the USER.md profile
  const profilePath = path.join(os.homedir(), '.dojo', 'prompts', 'USER.md');

  let profileContent = '';
  try { profileContent = fs.readFileSync(profilePath, 'utf-8'); } catch { /* ok */ }

  if (profileContent.trim().length < 50) {
    logger.info('USER.md too short, skipping first-run profile bootstrap');
    return { dreamerId: null };
  }

  const db = getDb();

  logger.info('Spawning first-run Dreamer to bootstrap profile into vault');

  try {
    const result = await spawnAgent({
      parentId: primaryId,
      name: 'Dreamer',
      systemPrompt: `You are processing the dojo owner's profile to optimize token usage. You have one job: split the profile into two parts.

PART 1 (stays in USER.md): Anything the agent needs to know on EVERY turn to behave correctly. This means:
- The owner's name and where they live and their timezone
- How they want to be communicated with
- How they want work done
- What to never do
- Scheduling constraints that affect the agent's behavior
- Work style rules

PART 2 (goes to the vault via vault_remember): Everything else. Biographical details, family members, business descriptions, vehicles, pets, hobbies, interests, food and music preferences, political views, etc. These are facts the agent only needs when the topic comes up.

Instructions:
1. Read the entire profile
2. For each piece of information, decide: does the agent need this to behave correctly on every turn regardless of topic? If yes, it stays. If no, it goes to the vault.
3. Call vault_remember for each fact being moved to the vault. Use the correct type (fact, relationship, preference). Set permanent: true for things that are definitionally stable (names, family, businesses, locations, birth dates).
4. Write the trimmed USER.md to "${profilePath}" using file_write. It should contain ONLY the behavioral and operational content. Do not summarize or reword the behavioral content. Keep the owner's original phrasing.
5. Call complete_task when done.`,
      modelId,
      classification: 'ronin',
      timeout: 3600,
      persist: false,
      toolsPolicy: {
        allow: [
          'vault_remember',
          'vault_search',
          'file_read',
          'file_write',
          'get_current_time',
          'complete_task',
        ],
        deny: [],
      },
      permissions: {
        file_read: [profilePath],
        file_write: [profilePath],
        file_delete: 'none',
        exec_allow: [],
        exec_deny: ['*'],
        network_domains: 'none',
        max_processes: 0,
        can_spawn_agents: false,
        can_assign_permissions: false,
        system_control: [],
      },
      initialMessage: `Here is the owner's profile. Extract reference facts into the vault, then rewrite the file with those facts removed. Keep all behavioral and operational instructions.

--- USER PROFILE (${profilePath}) ---
${profileContent}
--- END USER PROFILE ---

Use vault_remember for each fact extracted, then file_write to save the trimmed USER.md. Do NOT touch SOUL.md.`,
    });

    logger.info('First-run Dreamer spawned for profile bootstrap', { dreamerId: result.agentId });
    return { dreamerId: result.agentId };
  } catch (err) {
    logger.error('Failed to spawn first-run Dreamer', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { dreamerId: null };
  }
}

// ── Dreaming Scheduler ──

let dreamTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleDreamingCycle(): void {
  if (dreamTimer) {
    clearTimeout(dreamTimer);
    dreamTimer = null;
  }

  const config = getDreamingConfig();
  if (config.dreamMode === 'off') {
    logger.info('Dreaming is disabled, not scheduling');
    return;
  }

  const [hours, minutes] = config.dreamTime.split(':').map(Number);
  const now = new Date();
  const next = new Date();
  next.setHours(hours, minutes, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  const delay = next.getTime() - now.getTime();

  logger.info('Dreaming cycle scheduled', {
    nextDream: next.toISOString(),
    delayMs: delay,
    mode: config.dreamMode,
  });

  dreamTimer = setTimeout(async () => {
    try {
      await runDreamingCycle();
    } catch (err) {
      logger.error('Dreaming cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Reschedule for next day
    scheduleDreamingCycle();
  }, delay);
}

export function cancelDreamingSchedule(): void {
  if (dreamTimer) {
    clearTimeout(dreamTimer);
    dreamTimer = null;
    logger.info('Dreaming schedule cancelled');
  }
}
