// Vault maintenance, the dreaming cycle: wakes the Dreamer to process vault conversations, extract
// knowledge and maintain the vault. Engine-level pruning runs first.

import { primaryReady } from '../agent/primary-ready.js';
import fs from 'node:fs';
import { estimateTokens } from '../memory/budget.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from '../db/connection.js';
import { setConfigValue } from '../config/config-value.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { spawnAgent, jobBrief } from '../agent/spawner.js';
import { redriveWithoutReply } from '../agent/agent-notice.js';
import { getAgentRuntime } from '../agent/runtime.js';
import { activeRuns, pendingWakeups } from '../agent/shared-state.js';
import { rehomeUnclaimedEngineEvents } from '../agent/v2/counterparty.js';
import {
  getPrimaryAgentId,
  getDreamerAgentId, getDreamerAgentName,
  isSetupCompleted,
} from '../config/platform.js';
import type { Message } from '@dojo/shared';
import { isPlatformNoise as isSharedPlatformNoise } from '../memory/platform-noise.js';
import { insertMessageIfAbsent, rewriteSystemPromptRow } from '../memory/message-store.js';
import { v4 as uuidv4 } from 'uuid';
import {
  getConversation,
  getUnprocessedConversations,
  getVaultStats,
  createDreamReport,
  incrementArchiveAttempt,
  markArchivePoisoned,
  sqlUtcStamp,
  restoreCleanupHidesOnce,
  type VaultConversation,
} from './store.js';
import { buildRoughTasksBatch, lessonsCensusSince, advanceLessonsCensus } from './rough-tasks-batch.js';
import { homeDir } from '../home.js';
import { obligationVerdict } from '../work/obligation-memory.js';
import { fenceExternal } from '../tools/external-content.js';
import { nextDailyRunDelayMs } from '../config/clock-time.js';
import { isFiller, beginFillerPass } from './filler.js';
import { serviceAgentModelId } from '../agent/main-model-floor.js';
import { settleFiller } from '../memory/shape-judgment.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const logger = createLogger('vault-dreaming');

// A Dreamer that dies mid-batch stays 'working' and would block every cycle (the cycle advances only via a
// terminal complete_task). A genuinely running turn keeps the row's updated_at fresh (30s status heartbeat)
// and holds an activeRuns entry in this process; absent both past this window, there is no live run.
const DREAMER_STALE_MINUTES = 30;
// Do not re-arm the continuation sweep on a batch woken within this window (the staleness window, so a slow
// live batch is never double-woken). Set on every wake in wakeupDreamer, the single choke point.
const DREAMER_CONTINUATION_QUIET_MS = DREAMER_STALE_MINUTES * 60 * 1000;
let lastDreamerWakeMs = 0;


export function getDreamingConfig(): { modelId: string | null; dreamTime: string } {
  const db = getDb();

  const modelRow = db.prepare("SELECT value FROM config WHERE key = 'dreaming_model_id'").get() as { value: string } | undefined;
  const timeRow = db.prepare("SELECT value FROM config WHERE key = 'dreaming_time'").get() as { value: string } | undefined;

  return {
    modelId: modelRow?.value ?? null,
    dreamTime: timeRow?.value ?? '03:00',
  };
}

export function setDreamingConfig(config: { modelId?: string; dreamTime?: string }): void {
  if (config.modelId !== undefined) setConfigValue('dreaming_model_id', config.modelId);
  if (config.dreamTime !== undefined) setConfigValue('dreaming_time', config.dreamTime);
}

// DB-persisted flag (config table, so it survives a restart) that a NIGHTLY dream cycle is draining
// archives. Set when runDreamingCycle commits to waking the first batch; cleared in finalizeDreamCycle
// (rich-state and resumed paths). Dreamer cycles are once per night: the mid-day continuation sweep only
// recovers a STALLED nightly cycle and proceeds only while this marker is open, so daytime archives wait
// for tonight's window. runDreamingCycle sets it fresh each night, which heals a leaked marker.
const DREAM_CYCLE_OPEN_KEY = 'dream_cycle_open';

// Exported for dream-cycle-marker.test.ts and diagnostics.
export function isDreamCycleOpen(): boolean {
  const db = getDb();
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(DREAM_CYCLE_OPEN_KEY) as
    | { value: string }
    | undefined;
  return row?.value === '1';
}

export function setDreamCycleOpen(open: boolean): void {
  setConfigValue(DREAM_CYCLE_OPEN_KEY, open ? '1' : '0');
}


/** The model the Dreamer runs: its agent row's (a replacement may differ from the setting), else the setting, else a default. */
function dreamerModelId(): string | null {
  const row = getDb().prepare('SELECT a.model_id FROM agents a JOIN models m ON m.id = a.model_id WHERE a.id = ?').get(getDreamerAgentId()) as { model_id: string } | undefined;
  return row?.model_id ?? getDreamingConfig().modelId ?? getDefaultDreamModel();
}

function getDefaultDreamModel(): string | null {
  const db = getDb();
  // Must be a text-capable model: media-generation/embedding models cost 0 and would win the cost tiebreak.
  const model = db.prepare(`
    SELECT id FROM models WHERE is_enabled = 1
      AND capabilities NOT LIKE '%generation%'
      AND capabilities NOT LIKE '%embedding%'
    ORDER BY
      CASE WHEN api_model_id LIKE '%sonnet%' THEN 0
           WHEN api_model_id LIKE '%gpt-4o%' THEN 1
           ELSE 2 END,
      COALESCE(input_cost_per_m, 1e18) ASC, id ASC
    LIMIT 1
  `).get() as { id: string } | undefined;
  return model?.id ?? null;
}


export function runEngineMaintenance(): { pruned: number; decayed: number; unpinned: number; agedOut: number } {
  restoreCleanupHidesOnce((content) => obligationVerdict(content).kind === 'closed');
  const db = getDb();
  let pruned = 0;

  // Entries with confidence < 0.1 are marked obsolete, never deleted: an obsolete row is
  // still searchable, and owner data is never lost by a clean-up.
  const fadedOut = db.prepare(
    'UPDATE vault_entries SET is_obsolete = 1, updated_at = datetime(\'now\') WHERE confidence < 0.1 AND is_obsolete = 0 AND is_pinned = 0 AND is_permanent = 0'
  ).run();
  pruned += fadedOut.changes;

  // Mark obsolete: confidence < 0.5, never retrieved, older than 7 days
  const sevenDaysAgo = sqlUtcStamp(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
  const lowConfidence = db.prepare(
    'UPDATE vault_entries SET is_obsolete = 1, updated_at = datetime(\'now\') WHERE confidence < 0.5 AND retrieval_count = 0 AND created_at < ? AND is_obsolete = 0 AND is_pinned = 0 AND is_permanent = 0'
  ).run(sevenDaysAgo);
  pruned += lowConfidence.changes;

  // Decay confidence: not retrieved in 30 days, not pinned, not permanent; at most one step per 30 days
  // (last_decayed_at)
  const thirtyDaysAgo = sqlUtcStamp(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
  const decayResult = db.prepare(`
    UPDATE vault_entries SET confidence = MAX(0, confidence - 0.1), updated_at = datetime('now'),
      last_decayed_at = ?
    WHERE is_obsolete = 0 AND is_pinned = 0 AND is_permanent = 0
      AND (last_retrieved_at IS NULL OR last_retrieved_at < ?)
      AND created_at < ?
      AND (last_decayed_at IS NULL OR last_decayed_at < ?)
  `).run(sqlUtcStamp(new Date()), thirtyDaysAgo, thirtyDaysAgo, thirtyDaysAgo);

  // Pinning audit: unpin entries pinned 60+ days and not retrieved in the last 60 days; permanent entries
  // are exempt.
  const sixtyDaysAgo = sqlUtcStamp(new Date(Date.now() - 60 * 24 * 60 * 60 * 1000));
  const unpinResult = db.prepare(`
    UPDATE vault_entries SET is_pinned = 0, updated_at = datetime('now')
    WHERE is_pinned = 1 AND is_permanent = 0 AND is_obsolete = 0
      AND created_at < ?
      AND (last_retrieved_at IS NULL OR last_retrieved_at < ?)
  `).run(sixtyDaysAgo, sixtyDaysAgo);

  // Age-out: not pinned, not permanent, never retrieved, older than 180 days. Marked obsolete (not
  // deleted), so they stay searchable but stop burning vault retrieval slots.
  const oneEightyDaysAgo = sqlUtcStamp(new Date(Date.now() - 180 * 24 * 60 * 60 * 1000));
  const agedOutResult = db.prepare(`
    UPDATE vault_entries SET is_obsolete = 1, updated_at = datetime('now')
    WHERE is_obsolete = 0 AND is_pinned = 0 AND is_permanent = 0
      AND retrieval_count = 0
      AND created_at < ?
  `).run(oneEightyDaysAgo);

  if (pruned > 0) logger.info(`Engine maintenance: pruned ${pruned} low-value vault entries`);
  if (decayResult.changes > 0) logger.info(`Engine maintenance: decayed confidence on ${decayResult.changes} entries`);
  if (unpinResult.changes > 0) logger.info(`Engine maintenance: auto-unpinned ${unpinResult.changes} stale entries (pinned but not retrieved in 60 days)`);
  if (agedOutResult.changes > 0) logger.info(`Engine maintenance: aged out ${agedOutResult.changes} cold entries (never retrieved in 180 days)`);

  return {
    pruned,
    decayed: decayResult.changes,
    unpinned: unpinResult.changes,
    agedOut: agedOutResult.changes,
  };
}


// Context window reserved for the system prompt, tool definitions (~15 tools, ~20K tokens of schemas),
// vault retrieval injection, task injection, continuity brief and other context the assembler adds before
// the cycle message.
const CONTEXT_OVERHEAD_TOKENS = 50000;

// Batch text grows during processing (tool calls and results accumulate, up to ~1.5x by complete_task), so
// the batch text is budgeted down to keep the FULL turn under the context window.
const PROCESSING_GROWTH_FACTOR = 1.5;

// Per-message char cap: the Dreamer needs the gist, and a message with more signal belongs in a vault entry
// of its own.
const MAX_MESSAGE_CHARS = 1500;

// Per-archive char cap: past it the head and tail are kept and the middle elided (decisions live in the
// bookends).
const MAX_ARCHIVE_BODY_CHARS = 8000;

// Hard ceiling: raw archive text never exceeds 35% of the model's window, leaving the rest for the system
// prompt, tools and tool-call accumulation.
const BATCH_BUDGET_CAP_RATIO = 0.35;

// Engine-side noise stripping: archives are pre-processed in pure code, dropping platform mechanics and
// tool_result payloads before the model sees them. The platform-noise taxonomy lives in
// memory/platform-noise so the archiver and live compaction agree on plumbing vs. conversation; the local
// isPlatformNoise wrapper delegates to it.

function isPlatformNoise(content: string): boolean {
  return isSharedPlatformNoise(content);
}

// Extracts the text from an assistant content-block array; tool_use blocks are dropped (the Dreamer needs
// what the agent said, not which tools it called).
function extractAssistantText(content: string): string {
  if (!content) return '';
  const trimmed = content.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return content;
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return content; }
  if (!Array.isArray(parsed)) return content;
  const parts: string[] = [];
  for (const blk of parsed as Array<Record<string, unknown>>) {
    if (blk?.type === 'text' && typeof blk.text === 'string' && blk.text.trim().length > 0) {
      parts.push(blk.text);
    }
  }
  return parts.join('\n');
}

function truncateMessageContent(content: string): string {
  if (content.length <= MAX_MESSAGE_CHARS) return content;
  const head = content.slice(0, MAX_MESSAGE_CHARS);
  const truncatedChars = content.length - MAX_MESSAGE_CHARS;
  return `${head}\n…[truncated ${truncatedChars} chars from this message, original was ${content.length} chars]`;
}

interface ParsedArchiveMessage {
  role: string;
  content: string;
  createdAt?: string;
  party?: string | null;
}

function parseArchiveMessages(conv: VaultConversation): ParsedArchiveMessage[] | null {
  try {
    return JSON.parse(conv.messages) as ParsedArchiveMessage[];
  } catch {
    return null;
  }
}

// Aggressive pre-LLM trimming: the Dreamer needs what the user wanted and what the agent decided. Rules,
// most aggressive first: drop role='tool' messages; keep only text blocks of assistant content-block
// arrays; drop user messages that are purely tool_result blocks; drop platform noise; drop filler (acks,
// thanks) and assistant process narration; drop messages under 30 chars after compression.
export function preprocessMessages(messages: ParsedArchiveMessage[]): ParsedArchiveMessage[] {
  const filtered: ParsedArchiveMessage[] = [];
  for (const m of messages) {
    const role = (m.role ?? '').toLowerCase();
    let content = m.content ?? '';

    if (role === 'tool') continue;

    if (role === 'assistant') {
      content = extractAssistantText(content);
    } else if (role === 'user') {
      // A "user" message can be a tool_result wrapper (sub-agent replies); drop it, it has no prose value.
      const trimmed = content.trim();
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            const blocks = parsed as Array<Record<string, unknown>>;
            const allToolResults = blocks.length > 0 && blocks.every(b => b.type === 'tool_result');
            if (allToolResults) continue; // drop entirely
            const textParts = blocks
              .filter(b => b.type === 'text' && typeof b.text === 'string')
              .map(b => b.text as string);
            if (textParts.length === 0) continue;
            content = textParts.join('\n');
          }
        } catch { /* not JSON, leave as-is */ }
      }
    }

    if (isPlatformNoise(content)) continue;
    if ((role === 'assistant' || role === 'user') && isFiller(content, role)) continue;
    if (content.trim().length < 30) continue;

    filtered.push({ role: m.role, content, createdAt: m.createdAt, party: m.party });
  }
  return filtered;
}

function formatArchiveMessage(m: ParsedArchiveMessage): string {
  const role = (m.role ?? 'unknown').toUpperCase();
  const party = m.party ? ` · ${m.party}` : '';
  const ts = m.createdAt ? ` [${m.createdAt}]` : '';
  const body = truncateMessageContent(m.content ?? '');
  return `[${role}${party}${ts}] ${body}`;
}

export function wrapArchive(conv: VaultConversation, body: string, partLabel?: string): string {
  // What the archived conversation says is information for the Dreamer, never orders.
  const partTag = partLabel ? `, ${partLabel}` : '';
  return `=== ARCHIVE: ${conv.agentName ?? conv.agentId} (ID: ${conv.id})${partTag} ===
${conv.messageCount} messages, ${conv.earliestAt} to ${conv.latestAt}

${fenceExternal('archive', `the conversation archive ${conv.id}`, body)}

=== END ARCHIVE${partTag} ===`;
}

function formatArchive(conv: VaultConversation): string | null {
  const raw = parseArchiveMessages(conv);
  if (!raw) return null;
  const messages = preprocessMessages(raw);
  if (messages.length === 0) return null;
  let body = messages.map(formatArchiveMessage).join('\n\n');

  // Per-archive hard cap: past MAX_ARCHIVE_BODY_CHARS keep the head (what the user wanted) and the tail
  // (what was delivered) and elide the middle.
  if (body.length > MAX_ARCHIVE_BODY_CHARS) {
    const half = Math.floor(MAX_ARCHIVE_BODY_CHARS / 2);
    const head = body.slice(0, half);
    const tail = body.slice(-half);
    const elided = body.length - head.length - tail.length;
    body = `${head}\n\n…[mid-archive elided: ${elided} chars of exploration/process between the bookends]…\n\n${tail}`;
  }

  return wrapArchive(conv, body);
}

// Triviality check: returns a reason when an archive can be skipped without calling the Dreamer, else null.
// Conservative: feeding an extra archive to the model beats discarding something the user wanted remembered.
function classifyTrivial(conv: VaultConversation): string | null {
  const raw = parseArchiveMessages(conv);
  if (!raw || raw.length === 0) return 'unparseable or empty';

  const cleaned = preprocessMessages(raw);
  if (cleaned.length === 0) return 'no content after platform-noise strip';

  let proseChars = 0;
  let assistantText = 0;
  let userText = 0;
  for (const m of cleaned) {
    const role = (m.role ?? '').toLowerCase();
    const content = m.content ?? '';
    if (role === 'tool') continue;
    proseChars += content.length;
    if (role === 'assistant') assistantText += content.length;
    if (role === 'user') userText += content.length;
  }

  if (cleaned.length < 4 && proseChars < 400) return `tiny (${cleaned.length} msgs, ${proseChars} prose chars)`;
  if (proseChars < 200) return `low signal (${proseChars} prose chars after compression)`;
  if (assistantText < 100 && userText < 100) return 'no substantive prose from either side';

  return null;
}

// Splits an oversized archive into parts at message boundaries; each part carries the archive header so the
// Dreamer knows it is a continuation. The caller maps the same archive ID to all parts.
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

    // A single message can still exceed the budget on tiny-context models; force-add it as its own part.
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

// Per-batch token budget: the window minus overhead (at least a fifth of it), divided by (1 + growth factor),
// capped at BATCH_BUDGET_CAP_RATIO of the window, never under 2000.
function batchBudgetTokens(contextWindow: number): number {
  const rawBudget = Math.max(contextWindow - CONTEXT_OVERHEAD_TOKENS, Math.floor(contextWindow * 0.2));
  return Math.max(2000, Math.min(Math.floor(rawBudget / (1 + PROCESSING_GROWTH_FACTOR)), Math.floor(contextWindow * BATCH_BUDGET_CAP_RATIO)));
}

/** One unit of Dreamer work. `verbatim` text is sent as written (the ROUGH TASKS batch), not wrapped as archives. */
type DreamBatch = { ids: string[]; text: string; verbatim?: boolean };

function batchArchives(unprocessed: VaultConversation[], contextWindow: number): DreamBatch[] {
  const budgetTokens = batchBudgetTokens(contextWindow);

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

    // An oversized archive is split at message boundaries (nothing is truncated) and spread across Dreamer
    // cycles.
    if (archiveTokens > budgetTokens) {
      flush();

      const parts = splitArchive(conv, budgetTokens);
      if (parts.length === 0) continue;

      logger.warn('Archive too large for single batch, splitting', {
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

// Builds the cycle message for the permanent Dreamer; vault state and archive data go in the user message
// because the system prompt is fixed.
function buildDreamerCycleMessage(
  batchText: string,
  batchIndex: number,
  totalBatches: number,
  stats: ReturnType<typeof getVaultStats>,
  profilePath: string,
  soulPath: string,
  allUnprocessed: VaultConversation[],
): string {
  const batchNote = totalBatches > 1
    ? `\n\nThis is batch ${batchIndex + 1} of ${totalBatches}. Focus on these archives only. The remaining batches will be delivered after you call complete_task.`
    : '';

  // The queue overview states the total only: a numbered preview of the first N archives misled the Dreamer
  // into thinking only those were in scope. The batch text below carries every archive.
  const archiveSummary = allUnprocessed.length > 0
    ? `\n\nQueue: ${allUnprocessed.length} archive(s), all included in the batch text below. Process every archive in the batch.`
    : '';

  // File paths are not advertised in the header: it would cue the Dreamer to read USER.md/SOUL.md every
  // batch. The SOUL prompt says where the files live and when to touch them.
  void profilePath; void soulPath;

  return `═══ DREAM CYCLE ═══
Vault state: ${stats.totalEntries} entries (${stats.pinnedCount} pinned, ${stats.permanentCount} permanent).${archiveSummary}${batchNote}

Process the archives below. Extract durable memories and route each to the right store per your SOUL: vault_remember for general knowledge, contact_remember for person-as-entity facts (who someone is, role/company, relationships, channel preferences, a new email/phone), and credential_add ONLY when an archive contains the actual value of a service credential (follow your SOUL's cautions: never guess, skip anything personal-financial). Discard junk archives. Only update USER.md if an archive has a clear, explicit, FUNDAMENTAL profile change you can quote (see your SOUL). Never edit SOUL.md. Then call complete_task.

Conversation attribution: the archive messages are tagged with the party each is from ([USER · <the owner>], [USER · <a contact> (imessage)], [USER · <an address> (email)], [USER · <an agent> (agent)]). When a memory is a request, preference, or pending item that belongs to a SPECIFIC person or channel, say so in the memory text ("<the owner> asked to…", "<that contact> (email) is waiting on…"), and prefer contact_remember for who-someone-is facts. A memory that records one person's request must never read as if it were everyone's, keeping whose-is-whose is what lets the agent act on the right conversation later.

${batchText}`;
}


// send_to_agent and list_agents are deliberately NOT here: memory curation must not spawn more agent work.
// The Dreamer reads/writes vault and contacts, is add-only for credentials, edits USER.md only for
// FUNDAMENTAL profile changes, and keeps its own tracker bookkeeping. SOUL.md is engine-protected
// (GLOBAL_FILE_WRITE_DENY).
export const DREAMER_TOOLS_POLICY = JSON.stringify({
  allow: [
    'vault_remember', 'vault_search', 'vault_forget',
    'vault_discard_archives', 'lesson_record',
    'history_search', 'history_get',
    // Person-as-entity records: contact_remember upserts, so re-running each cycle refreshes the record,
    // not duplicates.
    'contact_remember', 'contact_search',
    // Service credentials: ADD + LIST only, deliberately NO credential_get, credential_update or
    // credential_delete (editing or removing a credential is the user's call, never the curator's).
    'credential_add', 'credential_list',
    'file_read', 'file_write',
    // tools_policy.allow is a NAME list (it filters the advertised surface), so it can only name tracker
    // verbs.
    'work_open', 'work_update', 'work_note',
    'get_current_time', 'load_tool_docs', 'complete_task',
  ],
});

function getDreamerPermissions(): string {
  const profilePath = path.join(homeDir(), '.dojo', 'prompts', 'USER.md');
  // USER.md only, for fundamental profile changes (new job, family status, a move); SOUL.md is
  // engine-protected.
  return JSON.stringify({
    file_read: [profilePath],
    file_write: [profilePath],
    exec_allow: [],
    exec_deny: ['*'],
    network_domains: 'none',
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
  return `You are the Dreamer, the dojo's memory keeper. Each night you process conversation archives into vault memories and, only for fundamental profile changes (new job, marital or family status, a move), keep USER.md up to date. You never edit SOUL.md. When done with each cycle, call complete_task.`;
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

  if (!primaryReady('Dreamer', primaryId, () => ensureDreamerAgentRunning())) return;

  const existing = db.prepare('SELECT id, status FROM agents WHERE id = ?').get(dreamerId) as
    | { id: string; status: string }
    | undefined;

  const dreamerPermissions = getDreamerPermissions();

  if (existing && existing.status !== 'terminated') {
    logger.info('Dreamer agent already running', { status: existing.status });
    // The Dreamer's `tools_policy` and `permissions` are not rewritten here: the channel invariant is held
    // at the doors by the grant, and only the create/reactivate paths below write the policy (they mint a
    // row rather than revert a live one).

    // Refresh the system prompt from the current DREAMER-SOUL.md by updating the earliest system message on
    // every check.
    try {
      const freshPrompt = loadDreamerSoulPrompt();
      const earliestSystem = db.prepare(
        "SELECT id, content FROM messages WHERE agent_id = ? AND role = 'system' ORDER BY created_at ASC, rowid ASC LIMIT 1"
      ).get(dreamerId) as { id: string; content: string } | undefined;
      if (earliestSystem) {
        if (earliestSystem.content !== freshPrompt) {
          rewriteSystemPromptRow(earliestSystem.id, freshPrompt);
          logger.info('Dreamer SOUL.md refreshed in messages table', { dreamerId });
        }
      } else {
        insertMessageIfAbsent({ id: uuidv4(), agentId: dreamerId, role: 'system', content: freshPrompt });
        logger.info('Dreamer SOUL.md inserted (was missing)', { dreamerId });
      }
    } catch (err) {
      logger.warn('Failed to refresh Dreamer SOUL.md', { error: err instanceof Error ? err.message : String(err) });
    }

    return;
  }

  const modelId = serviceAgentModelId('dreaming_model_id', primaryId);   // never a model under the floor

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

    insertMessageIfAbsent({ id: uuidv4(), agentId: dreamerId, role: 'system', content: systemPrompt });

    logger.info('Dreamer agent created', { dreamerId, dreamerName });
  }
}


function wakeupDreamer(cycleMessage: string): void {
  const db = getDb();
  const dreamerId = getDreamerAgentId();

  // Fresh-start reset: each batch message is self-contained, so the session starts again and carried-over
  // messages leave the view. Its summaries stay, as every agent's do across a reset.
  const boundary = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  db.prepare("UPDATE agents SET session_started_at = ?, updated_at = ?, config = json_remove(COALESCE(config, '{}'), '$.scratchpad') WHERE id = ?")
    .run(boundary, boundary, dreamerId);

  // Like the other reset paths, carry any fired-but-undelivered engine event across the boundary (a no-op
  // for the Dreamer, kept so every reset site is consistent).
  rehomeUnclaimedEngineEvents(dreamerId, boundary);

  // Forget the per-session scratch (fire-and-forget, best effort; this function is sync). A no-op for a
  // service agent, called so the five doors give one answer (see `agent/session-forget.ts`).
  void import('../agent/session-forget.js').then(({ forgetSessionScratch }) => forgetSessionScratch(dreamerId));

  logger.debug('Dreamer session reset for fresh context', { dreamerId });

  const msgId = uuidv4();
  // The cycle message is a plain role='user' row on the OWNER lane (origin_kind NULL), not an engine event:
  // the assembler lifts engine-origin user rows out of the live tail into the EVENTS lane
  // (memory/assembler.ts), which would divert the Dreamer's batch input. Cycle scoping is handled on the
  // trigger side by the isDreamerAgent skips in loop.ts.
  insertMessageIfAbsent({ id: msgId, agentId: dreamerId, role: 'user', content: cycleMessage });

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

  // Single wake choke point: record when a batch was last handed to the Dreamer (see
  // DREAMER_CONTINUATION_QUIET_MS).
  lastDreamerWakeMs = Date.now();

  const runtime = getAgentRuntime();
  runtime.handleMessage(dreamerId, cycleMessage).catch(err => {
    logger.error('Dreamer cycle failed', {
      error: err instanceof Error ? err.message : String(err),
    }, dreamerId);
  });
}


export async function runDreamingCycle(): Promise<{ dreamerId: string | null }> {
  const config = getDreamingConfig();

  // The technique-distillation engine pass rides the same nightly cadence (constraints in
  // techniques/distillation.ts). Deliberately not a Dreamer handoff: candidates go from the tracker's
  // outcome record straight to the Trainer.
  try {
    const { runDistillationCycle } = await import('../techniques/distillation.js');
    await runDistillationCycle();
  } catch (err) {
    logger.warn('Technique distillation pass failed (non-fatal to dreaming)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const modelId = dreamerModelId();
  if (!modelId) {
    logger.warn('No model available for dreaming cycle');
    return { dreamerId: null };
  }

  const primaryId = getPrimaryAgentId();
  if (!primaryId) {
    logger.warn('No primary agent found, cannot spawn Dreamer');
    return { dreamerId: null };
  }

  const profilePath = path.join(homeDir(), '.dojo', 'prompts', 'USER.md');
  const soulPath = path.join(homeDir(), '.dojo', 'prompts', 'SOUL.md');

  const maintenance = runEngineMaintenance();
  logger.info('Engine maintenance complete', maintenance);

  const allUnprocessed = getUnprocessedConversations();
  if (allUnprocessed.length === 0) {
    logger.info('No unprocessed conversation archives, skipping Dreamer spawn');
    broadcast({ type: 'dream:complete', data: { skipped: true, reason: 'no_archives', ...maintenance } });
    return { dreamerId: null };
  }

  // Engine-side triage: auto-skip archives not worth a model token (tiny conversations, platform-noise-only).
  const { markConversationProcessed } = await import('./store.js');
  const unprocessed: VaultConversation[] = [];
  let autoSkipped = 0;
  beginFillerPass();
  for (const conv of allUnprocessed) {
    const reason = classifyTrivial(conv);
    if (reason) {
      markConversationProcessed(conv.id);
      autoSkipped++;
      logger.debug('Auto-skipped trivial archive', { archiveId: conv.id, reason });
    } else {
      unprocessed.push(conv);
    }
  }
  await settleFiller(getDreamerAgentId());
  if (autoSkipped > 0) {
    logger.info(`Engine triage: auto-skipped ${autoSkipped} trivial archives, ${unprocessed.length} remain for the Dreamer`);
  }
  if (unprocessed.length === 0) {
    logger.info('No archives left after engine triage, Dreamer cycle skipped');
    broadcast({ type: 'dream:complete', data: { skipped: true, reason: 'all_trivial', autoSkipped, ...maintenance } });
    return { dreamerId: null };
  }

  const db = getDb();
  const modelRow = db.prepare('SELECT context_window FROM models WHERE id = ?').get(modelId) as { context_window: number } | undefined;
  const contextWindow = modelRow?.context_window ?? 32000; // conservative default

  const batches = batchArchives(unprocessed, contextWindow);
  const rough = buildRoughTasksBatch(lessonsCensusSince(), batchBudgetTokens(contextWindow));   // after the archives
  if (rough) batches.push(rough);

  logger.info(`Waking Dreamer to process ${unprocessed.length} archives in ${batches.length} batch(es)`, {
    modelId,
    contextWindow,
    batches: batches.length,
  });

  const stats = getVaultStats();

  // Wake the Dreamer for the first batch; later batches advance after each complete_task via
  // markDreamerArchivesProcessed.
  const firstBatch = batches[0];
  if (!firstBatch) {
    logger.warn('No valid archive batches to process');
    return { dreamerId: null };
  }

  ensureDreamerAgentRunning();

  const dreamerId = getDreamerAgentId();
  const dreamerState = db.prepare(`
    SELECT status,
      (updated_at < datetime('now', '-${DREAMER_STALE_MINUTES} minutes')) AS is_stale
    FROM agents WHERE id = ?
  `).get(dreamerId) as { status: string; is_stale: number } | undefined;

  if (dreamerState?.status === 'working') {
    // Distinguish a genuinely mid-batch Dreamer from a stuck one: the shared helper resets a corpse;
    // otherwise skip the cycle.
    if (!resetStuckDreamerIfDead(dreamerId, dreamerState.is_stale === 1)) {
      logger.warn('Dreamer is already running, skipping cycle', { dreamerId, liveInProcess: activeRuns.has(dreamerId) });
      return { dreamerId };
    }
  }

  // Store the remaining batches plus the cycle-reporting state used to write one dream_reports row at the
  // final batch.
  pendingBatches.set(primaryId, {
    batches,
    currentIndex: 0,
    config,
    primaryId,
    modelId,
    stats,
    cycleStartedAtMs: Date.now(),
    archivesProcessedThisCycle: 0,
    autoSkippedThisCycle: autoSkipped,
    totalArchivesAtStart: allUnprocessed.length,
    maintenanceAtStart: maintenance,
    vaultStatsBefore: stats,
  });

  // Store the first batch's archive IDs on the Dreamer record. Wrap the bound parameter in json(): without
  // it json_set stores a TEXT parameter as a string and the reader would iterate its characters, marking
  // nothing processed.
  db.prepare(`
    UPDATE agents SET config = json_set(COALESCE(config, '{}'), '$.dreamerArchiveIds', json(?))
    WHERE id = ?
  `).run(JSON.stringify(firstBatch.ids), dreamerId);

  const cycleMessage = buildDreamerCycleMessage(firstBatch.text, 0, batches.length, stats, profilePath, soulPath, unprocessed);

  // A nightly cycle is committing to a drain: open the cycle-in-flight marker (cleared at finalize).
  // Setting it here, reached only via runDreamingCycle, also heals a marker leaked by a crashed finalize.
  setDreamCycleOpen(true);

  wakeupDreamer(cycleMessage);

  logger.info('Dreamer agent woken', {
    dreamerId,
    batch: `1/${batches.length}`,
    archivesInBatch: firstBatch.ids.length,
    totalArchives: unprocessed.length,
  });

  return { dreamerId };
}


interface PendingBatchState {
  batches: DreamBatch[];
  currentIndex: number;
  config: ReturnType<typeof getDreamingConfig>;
  primaryId: string;
  modelId: string;
  stats: ReturnType<typeof getVaultStats>;
  // Context-overflow recoveries applied to the current batch; reset on advance, capped at MAX_RECOVERY_DEPTH.
  recoveryDepth?: number;

  // Cycle-level reporting state, used by writeDreamReportForCycle when the final batch completes.
  cycleStartedAtMs: number;
  archivesProcessedThisCycle: number;
  autoSkippedThisCycle: number;
  totalArchivesAtStart: number;
  maintenanceAtStart: { pruned: number; decayed: number; unpinned: number; agedOut: number };
  vaultStatsBefore: ReturnType<typeof getVaultStats>;
}

const MAX_RECOVERY_DEPTH = 3;

// How many terminal-but-not-'complete' Dreamer passes an archive may take before it is poisoned (parked and
// escalated) instead of retried forever. Context-overflow has its own recovery path
// (recoverDreamerFromContextOverflow).
const MAX_DREAM_ATTEMPTS = 3;

const pendingBatches = new Map<string, PendingBatchState>();

// Writes the dream_reports row for the cycle, when the final batch completes or a cycle is force-finalized
// on abort.
function writeDreamReportForCycle(state: PendingBatchState, outcome: 'complete' | 'aborted'): void {
  try {
    const after = getVaultStats();
    const before = state.vaultStatsBefore;
    const memoriesExtracted = Math.max(0, after.totalEntries - before.totalEntries);
    const durationMs = Date.now() - state.cycleStartedAtMs;

    const reportText = [
      `Dream cycle ${outcome}, ${state.archivesProcessedThisCycle}/${state.totalArchivesAtStart} archives processed by the Dreamer (${state.autoSkippedThisCycle} auto-skipped as trivial before the model was involved).`,
      `Vault entries: ${before.totalEntries} → ${after.totalEntries} (${memoriesExtracted >= 0 ? '+' : ''}${memoriesExtracted}).`,
      `Pinned: ${before.pinnedCount} → ${after.pinnedCount}. Permanent: ${before.permanentCount} → ${after.permanentCount}.`,
      `Engine maintenance: pruned ${state.maintenanceAtStart.pruned}, decayed ${state.maintenanceAtStart.decayed}, unpinned ${state.maintenanceAtStart.unpinned}, aged-out ${state.maintenanceAtStart.agedOut}.`,
      `Batches: ${state.batches.length}. Duration: ${Math.round(durationMs / 1000)}s.`,
    ].join('\n');

    createDreamReport({
      archivesProcessed: state.archivesProcessedThisCycle,
      memoriesExtracted,
      techniquesFound: 0, // Dreamer no longer hands off to the Trainer (v1.15.96)
      duplicatesMerged: 0,
      contradictionsResolved: 0,
      entriesPruned: state.maintenanceAtStart.pruned,
      entriesConsolidated: 0,
      totalEntries: after.totalEntries,
      pinnedCount: after.pinnedCount,
      permanentCount: after.permanentCount,
      reportText,
      modelId: state.modelId,
      durationMs,
    });

    logger.info('Dream report written', {
      outcome,
      archivesProcessed: state.archivesProcessedThisCycle,
      memoriesExtracted,
      durationMs,
    });
  } catch (err) {
    logger.warn('Failed to write dream report', { error: err instanceof Error ? err.message : String(err) });
  }
}

// Finalizes a cycle: writes the report, tears down the in-memory state and broadcasts completion. `state`
// is null when the counters were lost to a mid-cycle restart; a minimal labeled report is written instead
// of the rich one.
async function finalizeDreamCycle(primaryId: string, state: PendingBatchState | null): Promise<void> {
  if (state) {
    writeDreamReportForCycle(state, 'complete');
  } else {
    writeResumedDreamReport();
  }

  // The Dreamer must never message the primary agent: its output is the vault. The cycle is recorded to
  // dream_reports (the Dreams tab) and the owner-facing completion signal is the dream:complete broadcast
  // below; nothing is emitted to the primary.

  if (state) advanceLessonsCensus(state.cycleStartedAtMs);
  pendingBatches.delete(primaryId);
  // The drain is finished: close the cycle-in-flight marker. Reached from both the in-memory-state and the
  // resumed-after-restart (state === null) paths.
  setDreamCycleOpen(false);
  logger.info('All Dreamer batches complete', { totalBatches: state?.batches.length ?? 'resumed' });
  broadcast({ type: 'dream:complete', data: { batches: state?.batches.length ?? 0 } });
}

// Minimal dream report for a mid-cycle restart that wiped the in-memory counters: per-archive totals are
// unknown, so they are recorded as 0 and the reportText says so rather than fabricating a number.
function writeResumedDreamReport(): void {
  try {
    const after = getVaultStats();
    const config = getDreamingConfig();
    createDreamReport({
      archivesProcessed: 0,
      memoriesExtracted: 0,
      techniquesFound: 0,
      duplicatesMerged: 0,
      contradictionsResolved: 0,
      entriesPruned: 0,
      entriesConsolidated: 0,
      totalEntries: after.totalEntries,
      pinnedCount: after.pinnedCount,
      permanentCount: after.permanentCount,
      reportText:
        'Dream cycle finished after a mid-cycle restart. The in-memory cycle counters were lost, so per-archive totals are not available; the remaining archives were filed by the stateless DB-driven continuation.',
      modelId: config.modelId ?? undefined,
    });
    logger.info('Resumed dream report written (post-restart continuation)');
  } catch (err) {
    logger.warn('Failed to write resumed dream report', { error: err instanceof Error ? err.message : String(err) });
  }
}

// Stateless continuation: re-derives the next batch from the DB (remaining is_processed=0 AND poisoned=0
// archives) rather than the in-memory pendingBatches map, so a lost map (reload, crash, restart) never
// abandons a multi-batch cycle. Returns true if a batch was woken, false if nothing remains (the caller
// finalizes).
async function wakeNextBatchFromDb(primaryId: string, state: PendingBatchState | null): Promise<boolean> {
  const db = getDb();

  // Only ONE batch is used per call (batches[0]), so never load the whole queue's message blobs: that
  // freezes the event loop. Walk the metadata ASC and load content per row, collecting non-trivial rows
  // until their raw token_count passes 2x the context window (a guaranteed superset of batches[0]); batch
  // composition is unchanged.
  const { markConversationProcessed, getUnprocessedConversationMeta, getUnprocessedConversationById } = await import('./store.js');
  const queueMeta = getUnprocessedConversationMeta();
  if (queueMeta.length === 0) return false;

  const modelId = state?.modelId ?? dreamerModelId();
  if (!modelId) {
    logger.warn('No model available to continue dream cycle from DB');
    return false;
  }
  const modelRow = db.prepare('SELECT context_window FROM models WHERE id = ?').get(modelId) as
    | { context_window: number } | undefined;
  const contextWindow = modelRow?.context_window ?? 32000;

  // Bounded per-row load: trivial rows are marked processed; non-trivial rows are collected up to the
  // superset bound.
  const remaining: VaultConversation[] = [];
  let subsetTokens = 0;
  beginFillerPass();
  for (const meta of queueMeta) {
    if (subsetTokens > contextWindow * 2 && remaining.length > 0) break;
    const conv = getUnprocessedConversationById(meta.id);
    if (!conv) continue;
    const reason = classifyTrivial(conv);
    if (reason) {
      markConversationProcessed(conv.id);
      logger.debug('Auto-skipped trivial archive during continuation', { archiveId: conv.id, reason });
      continue;
    }
    remaining.push(conv);
    subsetTokens += Math.max(1, meta.tokenCount);
  }
  await settleFiller(getDreamerAgentId());
  if (remaining.length === 0) return false;

  const batches = batchArchives(remaining, contextWindow);
  const batch = batches[0];
  if (!batch) return false;

  const dreamerId = getDreamerAgentId();
  // json(?) stores the array AS JSON, not a quoted string (see runDreamingCycle).
  db.prepare(`
    UPDATE agents SET config = json_set(COALESCE(config, '{}'), '$.dreamerArchiveIds', json(?))
    WHERE id = ?
  `).run(JSON.stringify(batch.ids), dreamerId);

  const stats = state?.stats ?? getVaultStats();

  // Keep the in-memory state coherent: append the freshly derived batch if the precomputed ones are
  // exhausted, or rebuild a minimal state after a restart (its report is the labeled partial above).
  if (state) {
    state.batches.push(batch);
    state.currentIndex = state.batches.length - 1;
    state.recoveryDepth = 0;
  } else {
    const config = getDreamingConfig();
    pendingBatches.set(primaryId, {
      batches: [batch],
      currentIndex: 0,
      config,
      primaryId,
      modelId,
      stats,
      recoveryDepth: 0,
      cycleStartedAtMs: Date.now(),
      archivesProcessedThisCycle: 0,
      autoSkippedThisCycle: 0,
      totalArchivesAtStart: queueMeta.length,
      maintenanceAtStart: { pruned: 0, decayed: 0, unpinned: 0, agedOut: 0 },
      vaultStatsBefore: stats,
    });
  }

  const profilePath = path.join(homeDir(), '.dojo', 'prompts', 'USER.md');
  const soulPath = path.join(homeDir(), '.dojo', 'prompts', 'SOUL.md');
  // batchIndex 0 / totalBatches 1 keeps the "batch X of N" note off (N is not known statelessly).
  const cycleMessage = buildDreamerCycleMessage(
    batch.text, 0, 1, stats, profilePath, soulPath, [],
  );
  wakeupDreamer(cycleMessage);
  logger.info('Dreamer woken for next batch (stateless DB continuation)', {
    dreamerId, archivesInBatch: batch.ids.length, remaining: queueMeta.length, resumedAfterRestart: !state,
  });
  return true;
}

// After the Dreamer completes a batch, advance the cycle: through the precomputed in-memory batches while
// they remain (also the context-overflow recovery's sub-batches), else re-derive the next batch from the
// DB. Finalize only when the DB says nothing remains.
export async function spawnNextDreamerBatch(primaryId: string): Promise<void> {
  const state = pendingBatches.get(primaryId);

  // Path 1: in-memory fast path.
  if (state && state.currentIndex + 1 < state.batches.length) {
    const nextIndex = state.currentIndex + 1;
    state.currentIndex = nextIndex;
    state.recoveryDepth = 0; // fresh batch, reset overflow-recovery counter
    const batch = state.batches[nextIndex];

    logger.info(`Injecting next Dreamer batch ${nextIndex + 1}/${state.batches.length}`, {
      archivesInBatch: batch.ids.length,
    });

    const profilePath = path.join(homeDir(), '.dojo', 'prompts', 'USER.md');
    const soulPath = path.join(homeDir(), '.dojo', 'prompts', 'SOUL.md');

    try {
      const dreamerId = getDreamerAgentId();
      const db = getDb();

      // Update the archive IDs on the Dreamer record for this batch (json(?) as in runDreamingCycle).
      db.prepare(`
        UPDATE agents SET config = json_set(COALESCE(config, '{}'), '$.dreamerArchiveIds', json(?))
        WHERE id = ?
      `).run(JSON.stringify(batch.ids), dreamerId);

      const nextCycleMessage = batch.verbatim ? batch.text : buildDreamerCycleMessage(
        batch.text,
        nextIndex,
        state.batches.length,
        state.stats,
        profilePath,
        soulPath,
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
    return;
  }

  // Path 2: precomputed batches exhausted, or the map was lost (restart).
  const woke = await wakeNextBatchFromDb(primaryId, state ?? null);
  if (!woke) {
    await finalizeDreamCycle(primaryId, state ?? null);
  }
}


// Called when the Dreamer ends a batch on ANY terminal status, and by the continuation sweep with 'stalled' for a
// batch it re-sends. 'complete': every assigned archive is marked
// processed. 'blocked'/'fallen': the batch was NOT distilled, so never mark it processed; bump each
// archive's attempt counter and poison any that reached MAX_DREAM_ATTEMPTS (surfaced via the DREAM_POISONED
// diagnostic). Either way the cycle advances (spawnNextDreamerBatch). dreamerAgentId may be the permanent
// 'dreamer' ID or a legacy temporary agent ID.
export function markDreamerArchivesProcessed(
  dreamerAgentId: string,
  status: 'complete' | 'fallen' | 'blocked' | 'stalled' = 'complete',
): void {
  const db = getDb();

  // The permanent Dreamer's archive IDs are on the fixed Dreamer record; a legacy temporary agent falls
  // back to its ID.
  const permanentDreamerId = getDreamerAgentId();
  const lookupId = dreamerAgentId === permanentDreamerId ? permanentDreamerId : dreamerAgentId;

  const agent = db.prepare('SELECT config, parent_agent FROM agents WHERE id = ?').get(lookupId) as
    | { config: string; parent_agent: string | null }
    | undefined;
  if (!agent) return;

  try {
    const config = JSON.parse(agent.config || '{}');
    let archiveIds = config.dreamerArchiveIds as string[] | string | undefined;

    // Guard for a legacy shape: dreamerArchiveIds was once stored AS A STRING (json_set without json());
    // parse it back into an array, else the loop iterates characters and marks zero rows.
    if (typeof archiveIds === 'string') {
      try {
        const parsed = JSON.parse(archiveIds);
        if (Array.isArray(parsed)) {
          archiveIds = parsed as string[];
          logger.warn('Recovered legacy string-encoded dreamerArchiveIds, parsing as JSON', { dreamerAgentId, count: archiveIds.length });
        } else {
          logger.error('dreamerArchiveIds is a string but not a JSON array, refusing to iterate as chars', { dreamerAgentId });
          return;
        }
      } catch {
        logger.error('dreamerArchiveIds is a string but not valid JSON, refusing to iterate as chars', { dreamerAgentId });
        return;
      }
    }

    const primaryId = agent.parent_agent;

    if (!Array.isArray(archiveIds) || archiveIds.length === 0) {
      // No batch attribution on the record (a restart may have cleared config): still continue the cycle
      // from the DB.
      if (primaryId) {
        spawnNextDreamerBatch(primaryId).catch(err => {
          logger.error('Failed to advance Dreamer to next batch', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
      return;
    }

    let distilled = 0;
    if (status === 'complete') {
      for (const id of archiveIds) {
        if (typeof id !== 'string' || id.length < 8) continue; // sanity: archive IDs are uuids
        db.prepare("UPDATE vault_conversations SET is_processed = 1, processed_at = datetime('now') WHERE id = ?").run(id);
        distilled++;
      }
      logger.info(`Marked ${distilled} archives as processed after Dreamer completion`, { dreamerAgentId });
    } else {
      // A non-'complete' pass did NOT distill this batch: do not mark it processed; bump attempts and
      // poison at the cap.
      let poisonedNow = 0;
      for (const id of archiveIds) {
        if (typeof id !== 'string' || id.length < 8) continue;
        const attempts = incrementArchiveAttempt(id);
        if (attempts >= MAX_DREAM_ATTEMPTS) {
          markArchivePoisoned(
            id,
            `The Dreamer ended ${MAX_DREAM_ATTEMPTS} passes without filing this conversation (last outcome: ${status}).`,
          );
          poisonedNow++;
          logger.warn('Dreamer archive poisoned after repeated non-completion', {
            archiveId: id, attempts, status, dreamerAgentId,
          });
        }
      }
      logger.warn(
        `Dreamer batch ended '${status}' without completion; bumped attempts on ${archiveIds.length} archive(s), poisoned ${poisonedNow}`,
        { dreamerAgentId },
      );
    }

    // Bump the per-cycle counter: only 'complete' passes distill, a blocked/fallen pass contributes 0.
    if (primaryId) {
      const state = pendingBatches.get(primaryId);
      if (state && distilled > 0) {
        state.archivesProcessedThisCycle += distilled;
      }
      spawnNextDreamerBatch(primaryId).catch(err => {
        logger.error('Failed to advance Dreamer to next batch', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  } catch {
    // Best effort
  }
}


// The predicate lives in a leaf the summary writer can import without this module's graph; re-exported for
// the cascade.
export { isContextOverflowError } from '../agent/context-overflow.js';

// Recovers the Dreamer when its batch hit a context-overflow error: re-batches the failed batch's archives
// with a halved token budget (and message-level splitting if one archive is the culprit), replaces it with
// the smaller sub-batches and re-wakes the Dreamer. Returns false when no further splitting is possible
// (the caller treats it as a hard error).
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
    logger.warn('Context overflow detected but no pending batches, cannot recover', { dreamerAgentId });
    return false;
  }

  const currentBatch = state.batches[state.currentIndex];
  if (!currentBatch || currentBatch.ids.length === 0) return false;

  const depth = state.recoveryDepth ?? 0;
  if (depth >= MAX_RECOVERY_DEPTH) {
    logger.error('Context overflow recovery exhausted retries, giving up', {
      dreamerAgentId,
      depth,
      maxDepth: MAX_RECOVERY_DEPTH,
    });
    return false;
  }

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

  // Each recovery halves the prior budget (window/2, /4, /8), so a pathological batch is caught on a later
  // attempt.
  const shrinkFactor = 1 / Math.pow(2, depth + 1);
  const shrunkWindow = Math.max(4000, Math.floor(originalWindow * shrinkFactor));

  let newBatches = batchArchives(archives, shrunkWindow);

  // If the archives still fit one batch (the real tokenizer is denser than the estimate), force a tighter
  // split.
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

  // Replace the failed batch with the sub-batches; currentIndex now points at the first sub-batch.
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

  // Point the Dreamer record at the right archives for the completion handler (json(?), see runDreamingCycle).
  db.prepare(`
    UPDATE agents SET config = json_set(COALESCE(config, '{}'), '$.dreamerArchiveIds', json(?))
    WHERE id = ?
  `).run(JSON.stringify(nextBatch.ids), dreamerAgentId);

  const profilePath = path.join(homeDir(), '.dojo', 'prompts', 'USER.md');
  const soulPath = path.join(homeDir(), '.dojo', 'prompts', 'SOUL.md');

  const recoveryMessage = buildDreamerCycleMessage(
    nextBatch.text,
    state.currentIndex,
    state.batches.length,
    state.stats,
    profilePath,
    soulPath,
    [],
  );

  const noticedMessage = `[RECOVERY: The previous batch overflowed the model context. It was split into smaller pieces. Process this piece, then call complete_task to receive the next.]\n\n${recoveryMessage}`;

  wakeupDreamer(noticedMessage);

  return true;
}

// After the setup wizard, a Dreamer processes the user's "About You" profile (USER.md): long-term facts go
// to the vault, and the profile is trimmed to what is needed every turn.
export async function runFirstRunProfileBootstrap(): Promise<{ dreamerId: string | null }> {
  const modelId = dreamerModelId();
  if (!modelId) {
    logger.warn('No model available for first-run profile bootstrap');
    return { dreamerId: null };
  }

  const primaryId = getPrimaryAgentId();
  if (!primaryId) {
    logger.warn('No primary agent found for first-run profile bootstrap');
    return { dreamerId: null };
  }

  const profilePath = path.join(homeDir(), '.dojo', 'prompts', 'USER.md');

  let profileContent = '';
  try { profileContent = fs.readFileSync(profilePath, 'utf-8'); } catch { /* ok */ }

  if (profileContent.trim().length < 50) {
    logger.info('USER.md too short, skipping first-run profile bootstrap');
    return { dreamerId: null };
  }

  logger.info('Spawning first-run Dreamer to bootstrap profile into vault');

  const systemPrompt = `You are processing the dojo owner's profile to optimize token usage. You have one job: split the profile into two parts.

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
5. Call complete_task when done.`;
  const initialMessage = `Here is the owner's profile. Extract reference facts into the vault, then rewrite the file with those facts removed. Keep all behavioral and operational instructions.

--- USER PROFILE (${profilePath}) ---
${profileContent}
--- END USER PROFILE ---

Use vault_remember for each fact extracted, then file_write to save the trimmed USER.md. Do NOT touch SOUL.md. When both are done, call complete_task with status="complete" and a summary.`;

  try {
    const result = await spawnAgent({
      parentId: primaryId,
      name: 'Dreamer',
      systemPrompt,
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
        exec_allow: [],
        exec_deny: ['*'],
        network_domains: 'none',
        can_spawn_agents: false,
        can_assign_permissions: false,
        system_control: [],
      },
    });
    // A ronin made by the engine is given its job as a re-drive, which the one clock serves.
    await redriveWithoutReply({
      toAgentId: result.agentId, fromAgentId: null, content: await jobBrief({ agentId: result.agentId, systemPrompt, initialMessage }), taskId: null,
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

// Nightly engine jobs run BEFORE the Dreamer is woken: the disk reclaim's VACUUM needs no agent turn
// active, which is guaranteed only at the top of the window. Each job is best-effort: a failure is logged,
// retried next night, and never blocks dreaming.
async function runNightlyEngineMaintenance(): Promise<void> {
  // Vault-archive disk reclaim (redundant processed archives + guarded VACUUM).
  try {
    const { reclaimVaultArchiveSpace } = await import('./disk-reclaim.js');
    reclaimVaultArchiveSpace();
  } catch (err) {
    logger.error('Nightly disk reclaim failed (will retry next night)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Contaminated-summary rebuild (bounded batch; self-limiting once clean).
  try {
    const { runSummaryRebuildBatch } = await import('../memory/summary-rebuild.js');
    await runSummaryRebuildBatch();
  } catch (err) {
    logger.error('Nightly summary rebuild failed (will retry next night)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}


// Resets a Dreamer whose 'working' status is a corpse: no live in-process run AND updated_at past the
// staleness window. Returns true when the caller may proceed (reset, or not stuck), false when the Dreamer
// is genuinely mid-batch. Shared by runDreamingCycle (nightly) and sweepDreamerHealth (5-min hook).
function resetStuckDreamerIfDead(dreamerId: string, isStale: boolean): boolean {
  const liveInProcess = activeRuns.has(dreamerId);
  if (liveInProcess || !isStale) return false;
  logger.warn('Dreamer stuck in working state with no live run past staleness window, resetting to idle', {
    dreamerId,
    staleMinutes: DREAMER_STALE_MINUTES,
  });
  const db = getDb();
  db.prepare("UPDATE agents SET status = 'idle', updated_at = datetime('now') WHERE id = ?").run(dreamerId);
  activeRuns.delete(dreamerId);
  pendingWakeups.delete(dreamerId);
  broadcast({ type: 'agent:status', agentId: dreamerId, status: 'idle' });
  return true;
}

// The mid-day unstick hook, called from the runtime's periodic stuck-agent sweep: resets a corpse, then
// re-arms the continuation when unprocessed archives sit with an idle Dreamer and no recent wake. Never
// touches a live batch.
export async function sweepDreamerHealth(): Promise<void> {
  try {
    const dreamerId = getDreamerAgentId();
    const db = getDb();
    const row = db.prepare(`
      SELECT status,
        (updated_at < datetime('now', '-${DREAMER_STALE_MINUTES} minutes')) AS is_stale
      FROM agents WHERE id = ?
    `).get(dreamerId) as { status: string; is_stale: number } | undefined;
    if (row?.status === 'working') {
      resetStuckDreamerIfDead(dreamerId, row.is_stale === 1);
      return; // reset or genuinely live; either way the continuation sweep waits for idle
    }
    await runDreamerContinuationSweep();
  } catch (err) {
    logger.warn('sweepDreamerHealth failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Re-arms the stateless DB-driven continuation when a batch advance was dropped (a Dreamer that died
// mid-cycle, a lost in-memory map). Only when dreaming is enabled and setup complete, non-poisoned
// non-trivial archives remain, the Dreamer is idle (not 'working', no live run) and no batch was woken
// within the quiet window. The re-send counts as a stalled pass (markDreamerArchivesProcessed), then advances. No timer
// of its own: it runs on the nightly scheduler tick and on the runtime's stuck-agent sweep (sweepDreamerHealth).
export async function runDreamerContinuationSweep(): Promise<void> {
  try {
    if (!isSetupCompleted()) return;

    const primaryId = getPrimaryAgentId();
    if (!primaryId) return;

    // Cycle-in-flight gate: this sweep RECOVERS a stalled nightly cycle and must never START a drain for
    // daytime archives. Checked before any other work, so a closed marker costs one config read.
    if (!isDreamCycleOpen()) return;

    const dreamerId = getDreamerAgentId();
    if (activeRuns.has(dreamerId)) return; // a batch is live in this process
    const db = getDb();
    const row = db.prepare('SELECT status FROM agents WHERE id = ?').get(dreamerId) as { status: string } | undefined;
    if (row?.status === 'working') return; // genuinely mid-batch (staleness handled by runDreamingCycle)

    // Marker open, Dreamer idle: non-trivial work must remain (trivial archives are left to normal triage).
    // If nothing non-trivial remains, a finalize crashed before clearing the marker: finalize now. This
    // runs on a 5-minute tick, so it must NEVER load the whole queue's message blobs: walk the metadata and
    // load ONE row at a time, stopping at the first non-trivial hit.
    const { getUnprocessedConversationMeta, getUnprocessedConversationById } = await import('./store.js');
    const remainingMeta = getUnprocessedConversationMeta();
    let nonTrivialFound = false;
    for (const meta of remainingMeta) {
      const conv = getUnprocessedConversationById(meta.id);
      if (conv && classifyTrivial(conv) === null) { nonTrivialFound = true; break; }
    }
    if (!nonTrivialFound) {
      logger.warn('Dream cycle marker open but no non-trivial archives remain; finalizing leaked-open cycle', { dreamerId });
      await finalizeDreamCycle(primaryId, pendingBatches.get(primaryId) ?? null);
      return;
    }

    if (Date.now() - lastDreamerWakeMs < DREAMER_CONTINUATION_QUIET_MS) return; // a batch woke recently

    logger.warn('Dreamer continuation sweep: nightly cycle in flight with unprocessed archives and an idle Dreamer, re-arming batch continuation', {
      dreamerId,
      remaining: remainingMeta.length,
    });
    // A re-send counts as a pass that ended without filing its batch, so a batch is sent at most three times.
    markDreamerArchivesProcessed(dreamerId, 'stalled');
  } catch (err) {
    logger.warn('Dreamer continuation sweep failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}


let dreamTimer: ReturnType<typeof setTimeout> | null = null;


export function scheduleDreamingCycle(): void {
  if (dreamTimer) {
    clearTimeout(dreamTimer);
    dreamTimer = null;
  }

  const config = getDreamingConfig();
  const now = new Date();
  const { delayMs, usedFallback } = nextDailyRunDelayMs(config.dreamTime, '03:00', now);
  if (usedFallback) {
    logger.warn('Invalid dreamTime text; falling back to 03:00', {
      dreamTime: config.dreamTime,
    });
  }

  const delay = delayMs;
  const next = new Date(now.getTime() + delay);

  logger.info('Dreaming cycle scheduled', {
    nextDream: next.toISOString(),
    delayMs: delay,
  });

  dreamTimer = setTimeout(async () => {
    // Engine maintenance first (idle window, see runNightlyEngineMaintenance).
    try {
      await runNightlyEngineMaintenance();
    } catch (err) {
      logger.error('Nightly engine maintenance failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await runDreamingCycle();
    } catch (err) {
      logger.error('Dreaming cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Safety net on the same tick: re-arm the continuation if archives are unprocessed with an idle Dreamer
    // (a no-op whenever the cycle just woke a batch).
    await runDreamerContinuationSweep();
    // Reschedule for next day
    scheduleDreamingCycle();
  }, delay);
}
