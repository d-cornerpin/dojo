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
  getConversation,
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

// Conservative token estimate: 3 chars/token. The /4 heuristic underestimates
// for technical content (JSON, code, tool calls), which is most of what Dreamer
// processes. Underestimating leads to over-budget batches.
const CHARS_PER_TOKEN = 3;

// Reserve this much of the context window for system prompt, tool definitions
// (Dreamer has ~15 tools, ~20K tokens of schemas), vault retrieval injection,
// active task injection, continuity brief, and other context the assembler
// adds before the cycle message. Was 8K — way too low.
const CONTEXT_OVERHEAD_TOKENS = 50000;

// Multiplier for batch text growth during processing. As the Dreamer extracts
// knowledge from a batch, each archive generates many tool calls (vault_search,
// vault_remember, file_read, file_write) and tool results that accumulate in
// the conversation. Empirically the conversation can grow to ~1.5x the original
// batch text by the time complete_task fires. Budget the batch text down so
// the FULL turn (batch + accumulated tool calls) stays under context window.
const PROCESSING_GROWTH_FACTOR = 1.5;

// Cap any single message inside an archive (most often a huge tool_result with
// a file dump or scraped page) so one bloated row can't blow the batch budget.
// The Dreamer doesn't need the full payload — the gist suffices for knowledge
// extraction. 8K chars ≈ 2.5K tokens, plenty for context.
const MAX_MESSAGE_CHARS = 8000;

// Hard ceiling on per-batch text regardless of context window — never exceed
// 35% of the model's window for raw archive text. Leaves 65% for system
// prompt, tools, and turn-by-turn tool-call accumulation.
const BATCH_BUDGET_CAP_RATIO = 0.35;

function truncateMessageContent(content: string): string {
  if (content.length <= MAX_MESSAGE_CHARS) return content;
  const head = content.slice(0, MAX_MESSAGE_CHARS);
  const truncatedChars = content.length - MAX_MESSAGE_CHARS;
  return `${head}\n…[truncated ${truncatedChars} chars from this message — original was ${content.length} chars]`;
}

interface ParsedArchiveMessage {
  role: string;
  content: string;
  createdAt?: string;
}

function parseArchiveMessages(conv: VaultConversation): ParsedArchiveMessage[] | null {
  try {
    return JSON.parse(conv.messages) as ParsedArchiveMessage[];
  } catch {
    return null;
  }
}

function formatArchiveMessage(m: ParsedArchiveMessage): string {
  const role = (m.role ?? 'unknown').toUpperCase();
  const ts = m.createdAt ? ` [${m.createdAt}]` : '';
  const body = truncateMessageContent(m.content ?? '');
  return `[${role}${ts}] ${body}`;
}

function wrapArchive(conv: VaultConversation, body: string, partLabel?: string): string {
  const partTag = partLabel ? ` — ${partLabel}` : '';
  return `=== ARCHIVE: ${conv.agentName ?? conv.agentId} (ID: ${conv.id})${partTag} ===
${conv.messageCount} messages, ${conv.earliestAt} to ${conv.latestAt}

${body}

=== END ARCHIVE${partTag} ===`;
}

function formatArchive(conv: VaultConversation): string | null {
  const messages = parseArchiveMessages(conv);
  if (!messages) return null;
  const body = messages.map(formatArchiveMessage).join('\n\n');
  return wrapArchive(conv, body);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Split a single oversized archive into multiple batches at message boundaries.
 * Each part includes the archive header so the Dreamer knows it's a continuation.
 * Returns array of {text} objects — caller maps the same archive ID to all parts.
 */
function splitArchive(conv: VaultConversation, perBatchBudget: number): Array<{ text: string }> {
  const messages = parseArchiveMessages(conv);
  if (!messages || messages.length === 0) return [];

  const formatted = messages.map(formatArchiveMessage);
  const parts: Array<{ text: string }> = [];

  let currentMsgs: string[] = [];
  let currentTokens = 0;
  let partNum = 1;

  for (const msgText of formatted) {
    const msgTokens = estimateTokens(msgText);

    // Even after per-message truncation, a single message can still exceed
    // budget on tiny-context models. Force-add it as its own part.
    if (msgTokens > perBatchBudget) {
      if (currentMsgs.length > 0) {
        const partLabel = `PART ${partNum} (continued)`;
        parts.push({ text: wrapArchive(conv, currentMsgs.join('\n\n'), partLabel) });
        partNum++;
        currentMsgs = [];
        currentTokens = 0;
      }
      const partLabel = `PART ${partNum} (single oversized message)`;
      parts.push({ text: wrapArchive(conv, msgText, partLabel) });
      partNum++;
      continue;
    }

    if (currentTokens + msgTokens > perBatchBudget && currentMsgs.length > 0) {
      const partLabel = `PART ${partNum} (continued)`;
      parts.push({ text: wrapArchive(conv, currentMsgs.join('\n\n'), partLabel) });
      partNum++;
      currentMsgs = [];
      currentTokens = 0;
    }

    currentMsgs.push(msgText);
    currentTokens += msgTokens;
  }

  if (currentMsgs.length > 0) {
    const partLabel = parts.length === 0 ? undefined : `PART ${partNum} (final)`;
    parts.push({ text: wrapArchive(conv, currentMsgs.join('\n\n'), partLabel) });
  }

  return parts;
}

/**
 * Batch archives into chunks that fit within the model's context window.
 * Returns array of batches, each containing the archive IDs and formatted text.
 *
 * Budget calculation:
 *   raw_budget   = contextWindow - CONTEXT_OVERHEAD_TOKENS
 *   growth_budget = raw_budget / (1 + PROCESSING_GROWTH_FACTOR)
 *   final_budget  = min(growth_budget, contextWindow * BATCH_BUDGET_CAP_RATIO)
 *
 * For a 262K-token model: raw=212K → growth=85K → cap=92K → final=85K per batch.
 * For a 200K-token model: raw=150K → growth=60K → cap=70K → final=60K per batch.
 * For a  32K-token model: raw=−18K (clamped) → cap=11K → final=~10K per batch.
 */
function batchArchives(unprocessed: VaultConversation[], contextWindow: number): Array<{ ids: string[]; text: string }> {
  const rawBudget = Math.max(contextWindow - CONTEXT_OVERHEAD_TOKENS, Math.floor(contextWindow * 0.2));
  const growthBudget = Math.floor(rawBudget / (1 + PROCESSING_GROWTH_FACTOR));
  const cap = Math.floor(contextWindow * BATCH_BUDGET_CAP_RATIO);
  const budgetTokens = Math.max(2000, Math.min(growthBudget, cap));

  logger.info('Dreamer batch budget computed', {
    contextWindow,
    overhead: CONTEXT_OVERHEAD_TOKENS,
    growthFactor: PROCESSING_GROWTH_FACTOR,
    capRatio: BATCH_BUDGET_CAP_RATIO,
    budgetTokens,
  });

  const batches: Array<{ ids: string[]; text: string }> = [];

  let currentIds: string[] = [];
  let currentTexts: string[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (currentTexts.length === 0) return;
    batches.push({ ids: [...currentIds], text: currentTexts.join('\n\n') });
    currentIds = [];
    currentTexts = [];
    currentTokens = 0;
  };

  for (const conv of unprocessed) {
    const formatted = formatArchive(conv);
    if (!formatted) continue;

    const archiveTokens = estimateTokens(formatted);

    // If a single archive exceeds the budget, split it into multiple batches
    // at message boundaries. Previously we truncated the tail with "[TRUNCATED]"
    // which silently dropped data; splitting preserves everything but spreads
    // it across multiple Dreamer cycles.
    if (archiveTokens > budgetTokens) {
      flush();

      const parts = splitArchive(conv, budgetTokens);
      if (parts.length === 0) continue;

      logger.warn('Archive too large for single batch — splitting', {
        archiveId: conv.id,
        originalTokens: archiveTokens,
        budgetTokens,
        partCount: parts.length,
      });

      for (const part of parts) {
        batches.push({ ids: [conv.id], text: part.text });
      }
      continue;
    }

    // If adding this archive would exceed the budget, flush and start new batch
    if (currentTokens + archiveTokens > budgetTokens && currentTexts.length > 0) {
      flush();
    }

    currentIds.push(conv.id);
    currentTexts.push(formatted);
    currentTokens += archiveTokens;
  }

  flush();

  for (let i = 0; i < batches.length; i++) {
    const tokens = estimateTokens(batches[i].text);
    logger.info('Dreamer batch sized', {
      batchIndex: i + 1,
      totalBatches: batches.length,
      archiveCount: batches[i].ids.length,
      tokens,
      budgetTokens,
    });
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
    ? `\n- If a conversation shows a reusable multi-step procedure, hand it off to Trainer agent (${trainerName}, ID: ${trainerId}) via send_to_agent. MUST use intent="ASSIGN" — without it the Trainer will not wake.`
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

  // ── Fresh-start reset ──
  // The Dreamer doesn't need conversational continuity between runs.
  // Each batch message is self-contained. Without this reset, old messages
  // and compaction summaries accumulate until they fill the context window,
  // triggering repeated compaction/continuity-brief loops that stall the agent.
  const boundary = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  db.prepare("UPDATE agents SET session_started_at = ?, updated_at = ?, config = json_remove(COALESCE(config, '{}'), '$.continuityBrief') WHERE id = ?")
    .run(boundary, boundary, dreamerId);

  // Clear accumulated compaction summaries (context items)
  db.prepare('DELETE FROM context_items WHERE agent_id = ?').run(dreamerId);

  // Clear session-loaded tool docs (fire-and-forget — best effort)
  import('../tools/tool-docs.js')
    .then(({ clearSessionLoadedTools }) => clearSessionLoadedTools(dreamerId))
    .catch(() => { /* ignore */ });

  logger.debug('Dreamer session reset for fresh context', { dreamerId });

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
  // Number of context-overflow recoveries applied to the current batch.
  // Reset to 0 when advancing to the next batch (spawnNextDreamerBatch).
  // Capped at MAX_RECOVERY_DEPTH — beyond that, splitting further is
  // unlikely to help and we let the error propagate.
  recoveryDepth?: number;
}

const MAX_RECOVERY_DEPTH = 3;

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
  state.recoveryDepth = 0; // fresh batch — reset overflow-recovery counter
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

// ── Context Overflow Recovery ──

/**
 * Detect provider responses that indicate the prompt exceeded the model's
 * context window. Different providers phrase this differently, so we match
 * on common substrings rather than error codes.
 */
export function isContextOverflowError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('maximum context length') ||
    lower.includes('context_length_exceeded') ||
    lower.includes('prompt is too long') ||
    lower.includes('context length is') ||
    lower.includes('exceeds the context window') ||
    lower.includes('reduce the length') ||
    lower.includes('please reduce the length of the messages') ||
    lower.includes('input is too long') ||
    lower.includes('context window of')
  );
}

/**
 * Recover the Dreamer when its current batch produced a context-overflow error
 * mid-cycle. Re-batches the failed batch's archives with a halved token budget
 * (and message-level splitting if a single archive is the culprit), replaces
 * the failed batch with the smaller sub-batches in the pending queue, and
 * re-wakes the Dreamer with the first sub-batch.
 *
 * Returns true if a smaller batch was successfully prepared and the Dreamer
 * was re-woken; false if no further splitting is possible (caller should
 * treat as a hard error in that case).
 */
export async function recoverDreamerFromContextOverflow(
  dreamerAgentId: string,
  errorMessage: string,
): Promise<boolean> {
  if (dreamerAgentId !== getDreamerAgentId()) return false;

  const db = getDb();
  const dreamerRow = db.prepare('SELECT parent_agent FROM agents WHERE id = ?').get(dreamerAgentId) as
    | { parent_agent: string | null }
    | undefined;
  const primaryId = dreamerRow?.parent_agent;
  if (!primaryId) return false;

  const state = pendingBatches.get(primaryId);
  if (!state) {
    logger.warn('Context overflow detected but no pending batches — cannot recover', { dreamerAgentId });
    return false;
  }

  const currentBatch = state.batches[state.currentIndex];
  if (!currentBatch || currentBatch.ids.length === 0) return false;

  const depth = state.recoveryDepth ?? 0;
  if (depth >= MAX_RECOVERY_DEPTH) {
    logger.error('Context overflow recovery exhausted retries — giving up', {
      dreamerAgentId,
      depth,
      maxDepth: MAX_RECOVERY_DEPTH,
    });
    return false;
  }

  // Look up the source archives so we can re-batch them with a tighter budget.
  const archives: VaultConversation[] = [];
  for (const id of currentBatch.ids) {
    const conv = getConversation(id);
    if (conv) archives.push(conv);
  }
  if (archives.length === 0) return false;

  const modelRow = db.prepare('SELECT context_window FROM models WHERE id = ?').get(state.modelId) as
    | { context_window: number }
    | undefined;
  const originalWindow = modelRow?.context_window ?? 200000;

  // Progressive shrink: each recovery attempt halves the prior budget so a
  // pathological batch that survives one split still gets caught on the next.
  // depth=0: window/2, depth=1: window/4, depth=2: window/8.
  const shrinkFactor = 1 / Math.pow(2, depth + 1);
  const shrunkWindow = Math.max(4000, Math.floor(originalWindow * shrinkFactor));

  let newBatches = batchArchives(archives, shrunkWindow);

  // If batchArchives produced only one batch (the archive(s) still fit the
  // shrunk budget by char/token estimate), force a tighter split. This
  // happens when the real tokenizer is ~2x denser than our estimate.
  if (newBatches.length <= 1) {
    const tighter = Math.max(2000, Math.floor(shrunkWindow / 2));
    newBatches = batchArchives(archives, tighter);
  }

  if (newBatches.length <= 1) {
    logger.error('Context overflow recovery cannot split further', {
      dreamerAgentId,
      archiveIds: currentBatch.ids,
      originalWindow,
      shrunkWindow,
      depth,
    });
    return false;
  }

  state.recoveryDepth = depth + 1;

  // Replace the failed batch with the new sub-batches. currentIndex stays
  // the same — it now points at the first sub-batch.
  state.batches.splice(state.currentIndex, 1, ...newBatches);

  logger.warn('Dreamer batch split for context overflow recovery', {
    dreamerAgentId,
    archiveCount: archives.length,
    newSubBatchCount: newBatches.length,
    originalWindow,
    shrunkWindow,
    recoveryDepth: state.recoveryDepth,
    error: errorMessage.slice(0, 200),
  });

  const nextBatch = state.batches[state.currentIndex];
  if (!nextBatch) return false;

  // Update archive IDs on the dreamer agent record so completion handler
  // marks the right archives as processed.
  db.prepare(`
    UPDATE agents SET config = json_set(COALESCE(config, '{}'), '$.dreamerArchiveIds', ?)
    WHERE id = ?
  `).run(JSON.stringify(nextBatch.ids), dreamerAgentId);

  const profilePath = path.join(os.homedir(), '.dojo', 'prompts', 'USER.md');
  const soulPath = path.join(os.homedir(), '.dojo', 'prompts', 'SOUL.md');

  const recoveryMessage = buildDreamerCycleMessage(
    nextBatch.text,
    state.currentIndex,
    state.batches.length,
    state.stats,
    profilePath,
    soulPath,
    state.config.dreamMode,
    [],
  );

  const noticedMessage = `[RECOVERY: The previous batch overflowed the model context. It was split into smaller pieces. Process this piece, then call complete_task to receive the next.]\n\n${recoveryMessage}`;

  wakeupDreamer(noticedMessage);

  broadcast({
    type: 'dream:recovery',
    data: {
      reason: 'context_overflow',
      newSubBatchCount: newBatches.length,
      currentIndex: state.currentIndex,
      totalBatches: state.batches.length,
    },
  } as never);

  return true;
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
