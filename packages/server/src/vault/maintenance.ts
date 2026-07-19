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
import { activeRuns, pendingWakeups } from '../agent/shared-state.js';
import { rehomeUnclaimedEngineEvents } from '../agent/v2/counterparty.js';
import {
  getPrimaryAgentId,
  getDreamerAgentId, getDreamerAgentName,
  isSetupCompleted,
} from '../config/platform.js';
import type { Message } from '@dojo/shared';
import { isPlatformNoise as isSharedPlatformNoise } from '../memory/platform-noise.js';
import { v4 as uuidv4 } from 'uuid';
import {
  getConversation,
  getUnprocessedConversations,
  getVaultStats,
  createDreamReport,
  incrementArchiveAttempt,
  markArchivePoisoned,
  type VaultConversation,
} from './store.js';
import { MAX_PINNED_ENTRIES } from './retrieval.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const logger = createLogger('vault-dreaming');

export type DreamMode = 'full' | 'light' | 'off';

// ── Dreamer liveness (RC-15 unstick) ──
//
// The dream cycle advances only via a terminal complete_task, so a Dreamer that
// dies mid-batch leaves its status at 'working' with no live run and blocks
// every scheduled AND manual cycle. Liveness is detected exactly like the
// runtime's stuck-agent reaper: a genuinely running turn keeps the row's
// updated_at fresh via the 30s status heartbeat AND holds an activeRuns entry
// in this process. Absent both past this window, there is no live run.
const DREAMER_STALE_MINUTES = 30;
// Don't re-arm the continuation sweep on top of a batch that was woken within
// this window (matches the staleness window, so a live-but-slow batch is never
// double-woken). Set on every wake in wakeupDreamer, the single choke point.
const DREAMER_CONTINUATION_QUIET_MS = DREAMER_STALE_MINUTES * 60 * 1000;
let lastDreamerWakeMs = 0;

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

// ── Dream cycle in-flight marker (P2a cadence gate) ──
//
// A DB-persisted flag that a NIGHTLY dream cycle is currently draining archives.
// Set when runDreamingCycle commits to waking the first batch; cleared in
// finalizeDreamCycle (both the rich-state and the resumed-after-restart paths).
// Persisted in the config table (NOT in-memory) on purpose: FA-V4's whole point
// is surviving a mid-cycle restart, so the marker must too.
//
// Owner rule (2026-07-17): "dreamer cycles are once per night". The mid-day
// continuation sweep (runDreamerContinuationSweep) exists ONLY to recover a
// STALLED nightly cycle, never to START a fresh drain. It proceeds only while
// this marker is open, so archives produced during the day wait for tonight's
// window instead of re-entering drain mode every few minutes. The nightly tick
// self-heals a leaked marker because runDreamingCycle sets it fresh each night.
const DREAM_CYCLE_OPEN_KEY = 'dream_cycle_open';

// Exported for the P2a unit tests (dream-cycle-marker.test.ts) and available for
// diagnostics; the marker is otherwise driven only by runDreamingCycle (set) and
// finalizeDreamCycle (clear).
export function isDreamCycleOpen(): boolean {
  const db = getDb();
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(DREAM_CYCLE_OPEN_KEY) as
    | { value: string }
    | undefined;
  return row?.value === '1';
}

export function setDreamCycleOpen(open: boolean): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `).run(DREAM_CYCLE_OPEN_KEY, open ? '1' : '0', open ? '1' : '0');
}

// ── Get Default Model for Dreaming ──

function getDefaultDreamModel(): string | null {
  const db = getDb();
  // Must be a text-capable model: media-generation/embedding models cost 0 and
  // would otherwise win the cost tiebreak, breaking the dream LLM call.
  const model = db.prepare(`
    SELECT id FROM models WHERE is_enabled = 1
      AND capabilities NOT LIKE '%generation%'
      AND capabilities NOT LIKE '%embedding%'
    ORDER BY
      CASE WHEN api_model_id LIKE '%sonnet%' THEN 0
           WHEN api_model_id LIKE '%gpt-4o%' THEN 1
           ELSE 2 END,
      input_cost_per_m ASC, id ASC
    LIMIT 1
  `).get() as { id: string } | undefined;
  return model?.id ?? null;
}

// ── Engine-Level Maintenance (no LLM needed) ──

function runEngineMaintenance(): { pruned: number; decayed: number; unpinned: number; agedOut: number } {
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

  // ── Pinning audit ──
  // Auto-unpin entries that have been pinned for 60+ days but haven't been
  // retrieved in the last 60 days. Pinning is supposed to mean "I keep
  // reaching for this", if the agent's not reaching for it, it shouldn't
  // be earning premium context space. Permanent entries are exempt
  // (USER.md-grade facts that should always be top-of-context).
  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const unpinResult = db.prepare(`
    UPDATE vault_entries SET is_pinned = 0, updated_at = datetime('now')
    WHERE is_pinned = 1 AND is_permanent = 0 AND is_obsolete = 0
      AND created_at < ?
      AND (last_retrieved_at IS NULL OR last_retrieved_at < ?)
  `).run(sixtyDaysAgo, sixtyDaysAgo);

  // ── Age-out for cold entries ──
  // Mark obsolete: not pinned, not permanent, never retrieved, older than
  // 180 days. The vault should not be a dumping ground, entries that the
  // agent never reached for in 6 months are noise. They stay in the DB
  // (is_obsolete = 1) so they're still searchable via history_search if a
  // future agent needs them, but they don't burn vault retrieval slots.
  const oneEightyDaysAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
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

// Conservative token estimate: 3 chars/token. The /4 heuristic underestimates
// for technical content (JSON, code, tool calls), which is most of what Dreamer
// processes. Underestimating leads to over-budget batches.
const CHARS_PER_TOKEN = 3;

// Reserve this much of the context window for system prompt, tool definitions
// (Dreamer has ~15 tools, ~20K tokens of schemas), vault retrieval injection,
// active task injection, continuity brief, and other context the assembler
// adds before the cycle message. Was 8K, way too low.
const CONTEXT_OVERHEAD_TOKENS = 50000;

// Multiplier for batch text growth during processing. As the Dreamer extracts
// knowledge from a batch, each archive generates many tool calls (vault_search,
// vault_remember, file_read, file_write) and tool results that accumulate in
// the conversation. Empirically the conversation can grow to ~1.5x the original
// batch text by the time complete_task fires. Budget the batch text down so
// the FULL turn (batch + accumulated tool calls) stays under context window.
const PROCESSING_GROWTH_FACTOR = 1.5;

// Per-message char cap. The Dreamer doesn't need the full prose of any
// single message, the gist is enough. Aggressively low; if a single
// message has more than this much signal, it almost always belongs in a
// vault entry of its own (which the Dreamer will create from the truncated
// version anyway).
const MAX_MESSAGE_CHARS = 1500;

// Per-archive char cap. Once preprocessing is done, if the archive body
// is still over this, head + tail keep the bookends and the middle gets
// elided. Most projects' "what was decided" lives in the first and last
// turns; the middle is exploration.
const MAX_ARCHIVE_BODY_CHARS = 8000;

// tool_result content is essentially noise for memory extraction (file
// dumps, HTML, vault search hits, command output). We now drop tool
// messages entirely (see preprocessMessages) AND drop tool_use blocks
// from assistant content blocks. This constant is kept only as a fallback
// for legacy code paths.
const MAX_TOOL_RESULT_CHARS = 200;

// Hard ceiling on per-batch text regardless of context window, never exceed
// 35% of the model's window for raw archive text. Leaves 65% for system
// prompt, tools, and turn-by-turn tool-call accumulation.
const BATCH_BUDGET_CAP_RATIO = 0.35;

// ── Engine-side noise stripping ──
//
// The vault Dreamer was burning millions of tokens because the raw archives
// it processed were stuffed with platform mechanics (system nudges, session
// markers, healer pokes, tracker reorientation prompts, [SOURCE: AGENT
// MESSAGE FROM …] envelopes) and giant tool_result payloads (file_read
// dumps, web_fetch HTML, vault_search hit lists). None of that is
// memory-worthy. We pre-process archives in pure code before they reach
// the model, slashing the token cost of every cycle while keeping the
// signal, what the agent and user actually said and decided.

// Platform-noise taxonomy (sub-agent completions, PM/scheduler/healer pokes,
// session dividers, embedded SOUL prompts, synthetic acks) now lives in the
// shared memory/platform-noise module so the vault archiver and LIVE compaction
// agree on what is plumbing vs. conversation. Imported below; the local
// isPlatformNoise wrapper is kept so callers here are unchanged.

// Conversational filler, acknowledgments and process narration. Drop the
// whole message if its trimmed content matches. Length-bounded so prose
// containing "got it" doesn't get false-positived.
const FILLER_PATTERNS: RegExp[] = [
  /^(sure|got it|okay|ok|alright|understood|will do|on it|working on it now?|let me think( about (this|that))?|let me check|one moment|hmm|hmmm|right|yep|yes|no problem|sounds good|makes sense|of course)[.!]?$/i,
  /^(thanks|thank you)[.!]?$/i,
  // Process narration the agent emits between tool calls, pure scaffolding.
  /^(let me |i'?ll |i'?m going to |now i'?ll |first,? |next,? |then,? )/i,
  /^(checking|searching|reading|writing|looking at|analyzing|processing|continuing|proceeding)\b/i,
  /^(i found|i see|i notice|i can see|i'?ve found)\b/i,
];

function isPlatformNoise(content: string): boolean {
  return isSharedPlatformNoise(content);
}

function isFiller(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0) return true;
  // Allow process-narration patterns to be caught up to ~80 chars (one
  // sentence). True prose >100 chars is never filler.
  if (trimmed.length > 100) return false;
  for (const pat of FILLER_PATTERNS) {
    if (pat.test(trimmed)) return true;
  }
  return false;
}

// Extract just the text portion from an assistant content-block array.
// Drops tool_use blocks entirely, the Dreamer doesn't need to know
// which tools the agent called, only what it said. Pre-2026-04-30 we
// summarized tool_use blocks as one-liners (`[tool_use file_read path=…]`)
// which still added significant token cost across long conversations.
// Memory curation cares about the *content* of the conversation, not the
// process scaffolding.
function extractAssistantText(content: string): string {
  if (!content) return '';
  const trimmed = content.trim();
  // Plain text, return as-is.
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return content;
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return content; }
  if (!Array.isArray(parsed)) return content;
  const parts: string[] = [];
  for (const blk of parsed as Array<Record<string, unknown>>) {
    if (blk?.type === 'text' && typeof blk.text === 'string' && blk.text.trim().length > 0) {
      parts.push(blk.text);
    }
    // tool_use, image, document, etc., silently dropped.
  }
  return parts.join('\n');
}

// Compress a tool_use / tool_result payload into a one-liner. The model
// doesn't need the full file content / HTML / search hits, it needs to
// know what the agent did. "[file_read /path → 2,341 chars, 'export function …']"
// preserves the action and a tiny shape hint at ~95% token savings.
function summarizeToolBlock(block: Record<string, unknown>): string | null {
  if (block.type === 'tool_use') {
    const name = String(block.name ?? 'tool');
    const input = block.input as Record<string, unknown> | undefined;
    const summary = summarizeToolInput(name, input);
    return summary ? `[tool_use ${name}${summary}]` : `[tool_use ${name}]`;
  }
  if (block.type === 'tool_result') {
    const raw = typeof block.content === 'string'
      ? block.content
      : Array.isArray(block.content)
      ? (block.content as Array<{ type?: string; text?: string }>)
          .map(b => (b.type === 'text' ? (b.text ?? '') : `[${b.type ?? 'block'}]`))
          .filter(Boolean)
          .join(' ')
      : '';
    const isError = block.is_error === true;
    if (raw.length === 0) return `[tool_result${isError ? ' ERROR' : ''} (empty)]`;
    const oneLine = raw.replace(/\s+/g, ' ').trim();
    const head = oneLine.slice(0, MAX_TOOL_RESULT_CHARS);
    const note = oneLine.length > MAX_TOOL_RESULT_CHARS ? `…+${oneLine.length - MAX_TOOL_RESULT_CHARS}c` : '';
    return `[tool_result${isError ? ' ERROR' : ''} ${head}${note}]`;
  }
  if (block.type === 'image') return '[image]';
  if (block.type === 'document') return '[document]';
  return null;
}

function summarizeToolInput(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const fields: string[] = [];
  for (const key of ['path', 'file_path', 'url', 'query', 'agent', 'agent_id', 'task_id', 'name', 'shape_type', 'presentation_id', 'image_url', 'drive_file_id']) {
    if (key in input && typeof input[key] === 'string') {
      const val = input[key] as string;
      const trimmed = val.length > 80 ? val.slice(0, 80) + '…' : val;
      fields.push(`${key}=${JSON.stringify(trimmed)}`);
      if (fields.length >= 2) break;
    }
  }
  return fields.length > 0 ? ` ${fields.join(' ')}` : '';
}

// Some assistant content is a JSON-encoded array of content blocks
// (e.g. [{ type: 'text', text: '…' }, { type: 'tool_use', … }]).
// Summarize each block individually instead of feeding the raw JSON.
function compressContentBlocks(content: string): string {
  if (!content) return content;
  const trimmed = content.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return content;
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return content; }
  if (!Array.isArray(parsed)) return content;
  const parts: string[] = [];
  for (const blk of parsed as Array<Record<string, unknown>>) {
    if (blk?.type === 'text' && typeof blk.text === 'string') {
      parts.push(blk.text);
    } else {
      const summary = summarizeToolBlock(blk);
      if (summary) parts.push(summary);
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

// Aggressive pre-LLM trimming. The Dreamer needs the conversation, 
// what the user wanted, what the agent decided. Everything else is
// process scaffolding the model doesn't need.
//
// Rules (most aggressive at the top):
//   1. Drop role='tool' messages entirely. Tool results carry no memory
//      signal, file content, HTML, search hits.
//   2. From assistant messages that are JSON content-block arrays,
//      keep ONLY text blocks. Drop tool_use entirely.
//   3. From user messages whose content is purely tool_result blocks
//      (a sub-agent reply container), drop them.
//   4. Drop platform-noise messages (system nudges, cycle markers, etc.).
//   5. Drop conversational filler and process narration ("let me check…",
//      "now I'll search…").
//   6. Drop messages with < 30 chars after compression, almost always
//      acks, single words, or unhelpful fragments.
function preprocessMessages(messages: ParsedArchiveMessage[]): ParsedArchiveMessage[] {
  const filtered: ParsedArchiveMessage[] = [];
  for (const m of messages) {
    const role = (m.role ?? '').toLowerCase();
    let content = m.content ?? '';

    // (1) Drop tool messages outright.
    if (role === 'tool') continue;

    // (2/3) Compress assistant/user content blocks.
    if (role === 'assistant') {
      content = extractAssistantText(content);
    } else if (role === 'user') {
      // User messages are usually plain text. But a "user" message can
      // also be a tool_result wrapper (sub-agent replies, model API
      // shape). Detect and drop those, they have no prose value.
      const trimmed = content.trim();
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            const blocks = parsed as Array<Record<string, unknown>>;
            const allToolResults = blocks.length > 0 && blocks.every(b => b.type === 'tool_result');
            if (allToolResults) continue; // drop entirely
            // Mixed, keep text portions only.
            const textParts = blocks
              .filter(b => b.type === 'text' && typeof b.text === 'string')
              .map(b => b.text as string);
            if (textParts.length === 0) continue;
            content = textParts.join('\n');
          }
        } catch { /* not JSON, leave as-is */ }
      }
    }

    // (4) Platform noise.
    if (isPlatformNoise(content)) continue;
    // (5) Filler / process narration.
    if ((role === 'assistant' || role === 'user') && isFiller(content)) continue;
    // (6) Tiny / empty.
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

function wrapArchive(conv: VaultConversation, body: string, partLabel?: string): string {
  const partTag = partLabel ? `, ${partLabel}` : '';
  return `=== ARCHIVE: ${conv.agentName ?? conv.agentId} (ID: ${conv.id})${partTag} ===
${conv.messageCount} messages, ${conv.earliestAt} to ${conv.latestAt}

${body}

=== END ARCHIVE${partTag} ===`;
}

function formatArchive(conv: VaultConversation): string | null {
  const raw = parseArchiveMessages(conv);
  if (!raw) return null;
  const messages = preprocessMessages(raw);
  if (messages.length === 0) return null;
  let body = messages.map(formatArchiveMessage).join('\n\n');

  // Per-archive hard cap. After preprocessing, if an archive is still
  // bigger than MAX_ARCHIVE_BODY_CHARS, the middle is the boring part, 
  // exploration, false starts, intermediate reasoning. Keep the head
  // (what the user wanted) and the tail (what was decided / delivered)
  // and elide the middle. A sub-agent that did a 200-message build
  // session still produces a < 8KB summary worth feeding to the Dreamer.
  if (body.length > MAX_ARCHIVE_BODY_CHARS) {
    const half = Math.floor(MAX_ARCHIVE_BODY_CHARS / 2);
    const head = body.slice(0, half);
    const tail = body.slice(-half);
    const elided = body.length - head.length - tail.length;
    body = `${head}\n\n…[mid-archive elided: ${elided} chars of exploration/process between the bookends]…\n\n${tail}`;
  }

  return wrapArchive(conv, body);
}

// ── Triviality check (engine-side auto-skip) ──
//
// Decides whether an archive can be discarded without ever calling the
// Dreamer. "Trivial" = nothing here is worth a model token. Returns a
// reason string when the archive should be skipped, or null to keep it.
//
// Conservative on purpose: better to feed an extra archive through the
// model than to throw away something the user actually wanted remembered.
function classifyTrivial(conv: VaultConversation): string | null {
  const raw = parseArchiveMessages(conv);
  if (!raw || raw.length === 0) return 'unparseable or empty';

  const cleaned = preprocessMessages(raw);
  if (cleaned.length === 0) return 'no content after platform-noise strip';

  // Count what's left: prose vs. tool noise.
  let proseChars = 0;
  let assistantText = 0;
  let userText = 0;
  for (const m of cleaned) {
    const role = (m.role ?? '').toLowerCase();
    const content = m.content ?? '';
    // Skip tool-only content (already collapsed to one-liners).
    if (role === 'tool') continue;
    proseChars += content.length;
    if (role === 'assistant') assistantText += content.length;
    if (role === 'user') userText += content.length;
  }

  // Tiny conversations: not enough content to be worth extracting from.
  if (cleaned.length < 4 && proseChars < 400) return `tiny (${cleaned.length} msgs, ${proseChars} prose chars)`;
  if (proseChars < 200) return `low signal (${proseChars} prose chars after compression)`;
  if (assistantText < 100 && userText < 100) return 'no substantive prose from either side';

  return null;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Split a single oversized archive into multiple batches at message boundaries.
 * Each part includes the archive header so the Dreamer knows it's a continuation.
 * Returns array of {text} objects, caller maps the same archive ID to all parts.
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
 * This replaces the old dynamic system prompt, vault state and archive data
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
  const batchNote = totalBatches > 1
    ? `\n\nThis is batch ${batchIndex + 1} of ${totalBatches}. Focus on these archives only. The remaining batches will be delivered after you call complete_task.`
    : '';

  // Queue overview. Pre-2026-04-30 we enumerated the first N archives in
  // a numbered list, which (a) wasted tokens and (b) misled the Dreamer
  // into thinking only the listed ones were in scope, its complete_task
  // summaries kept saying "Processed N archives" matching the preview
  // count, not the actual batch size. Now we just state the total. The
  // batch text below contains every archive's content; that's what the
  // Dreamer reads anyway.
  const archiveSummary = allUnprocessed.length > 0
    ? `\n\nQueue: ${allUnprocessed.length} archive(s), all included in the batch text below. Process every archive in the batch.`
    : '';

  // Note: file paths are NOT advertised in the cycle header anymore. Doing
  // so cued the Dreamer to read USER.md/SOUL.md every batch as a matter of
  // routine, even when nothing in the archives required it. The SOUL prompt
  // tells the Dreamer where the files live and when to touch them. The
  // header is kept terse so the only routine work is what's in the archives.
  void profilePath; void soulPath;

  return `═══ DREAM CYCLE ═══
Vault state: ${stats.totalEntries} entries (${stats.pinnedCount} pinned, ${stats.permanentCount} permanent). Pin cap: ${MAX_PINNED_ENTRIES}${stats.pinnedCount > MAX_PINNED_ENTRIES ? ', OVER CAP, prune now' : ''}.${archiveSummary}${batchNote}

Process the archives below. Extract durable memories and route each to the right store per your SOUL: vault_remember for general knowledge, contact_remember for person-as-entity facts (who someone is, role/company, relationships, channel preferences, a new email/phone), and credential_add ONLY when an archive contains the actual value of a service credential (follow your SOUL's cautions: never guess, skip anything personal-financial). Discard junk archives. Only update USER.md if an archive has a clear, explicit, FUNDAMENTAL profile change you can quote (see your SOUL). Never edit SOUL.md. Then call complete_task.

Conversation attribution: the archive messages are tagged with the party each is from ([USER · Sam], [USER · Alex Chen (imessage)], [USER · priya@… (email)], [USER · Nova (agent)]). When a memory is a request, preference, or pending item that belongs to a SPECIFIC person or channel, say so in the memory text ("Sam asked to…", "Priya (email) is waiting on…"), and prefer contact_remember for who-someone-is facts. A memory that records one person's request must never read as if it were everyone's, keeping whose-is-whose is what lets the agent act on the right conversation later.

${batchText}`;
}

// ── Permanent Dreamer Tools & Permissions ──

// Note: send_to_agent and list_agents are intentionally NOT in this list.
// Pre-2026-04-30 the Dreamer was allowed to hand off "technique candidates"
// to the Trainer; that pattern caused extra token burn (Trainer wakes,
// runs its own loop) and sometimes broke other techniques the user had
// built. Memory curation should not have a side effect of spawning more
// agent work. The Dreamer is strictly read/write of vault + contacts, add-only
// for credentials, and USER.md (USER.md only for FUNDAMENTAL profile changes),
// plus its own tracker bookkeeping. SOUL.md is engine-protected
// (GLOBAL_FILE_WRITE_DENY) and never edited.
const DREAMER_TOOLS_POLICY = JSON.stringify({
  allow: [
    'vault_remember', 'vault_search', 'vault_forget',
    'vault_discard_archives',
    'history_search', 'history_get',
    // Person-as-entity records: the SOUL routes "who someone is" facts here
    // (role/company, relationships, channel prefs, a new email/phone) instead
    // of the vault. contact_remember upserts, so re-running each cycle keeps
    // the record fresh rather than duplicating it.
    'contact_remember', 'contact_search',
    // Service credentials: the SOUL routes an actual credential VALUE found in
    // an archive here. ADD + LIST only; deliberately NO credential_get (value
    // reads), credential_update, or credential_delete (editing/removing a
    // credential is the user's call, never the curator's).
    'credential_add', 'credential_list',
    'file_read', 'file_write',
    'tracker_create_project', 'tracker_create_task',
    'tracker_update_status', 'tracker_add_notes', 'tracker_complete_step',
    'tracker_list_projects',
    'get_current_time', 'load_tool_docs', 'complete_task',
  ],
});

function getDreamerPermissions(): string {
  const profilePath = path.join(os.homedir(), '.dojo', 'prompts', 'USER.md');
  // USER.md only. SOUL.md (identity) is engine-protected (GLOBAL_FILE_WRITE_DENY)
  // and never written by any agent; the Dreamer updates USER.md only for
  // fundamental profile changes (new job, marital/family status, a move).
  return JSON.stringify({
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

  const primaryExists = db.prepare('SELECT id FROM agents WHERE id = ?').get(primaryId);
  if (!primaryExists) {
    logger.warn('Primary agent not yet created, deferring Dreamer spawn', { primaryId });
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

    // Refresh the system prompt from the (potentially updated) DREAMER-SOUL.md
    // template. Pre-2026-04-30 the prompt was inserted once on agent creation
    // and never updated, so changes to the soul template only took effect
    // when the Dreamer was destroyed and recreated. Now we update the
    // earliest system message on every check so a SOUL.md rewrite (like
    // the curator-bias overhaul in v1.15.94) flows through immediately.
    try {
      const freshPrompt = loadDreamerSoulPrompt();
      const earliestSystem = db.prepare(
        "SELECT id, content FROM messages WHERE agent_id = ? AND role = 'system' ORDER BY created_at ASC, rowid ASC LIMIT 1"
      ).get(dreamerId) as { id: string; content: string } | undefined;
      if (earliestSystem) {
        if (earliestSystem.content !== freshPrompt) {
          db.prepare("UPDATE messages SET content = ? WHERE id = ?").run(freshPrompt, earliestSystem.id);
          logger.info('Dreamer SOUL.md refreshed in messages table', { dreamerId });
        }
      } else {
        // No system message yet, insert one.
        db.prepare(
          "INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at) VALUES (?, ?, 'system', ?, datetime('now'))"
        ).run(uuidv4(), dreamerId, freshPrompt);
        logger.info('Dreamer SOUL.md inserted (was missing)', { dreamerId });
      }
    } catch (err) {
      logger.warn('Failed to refresh Dreamer SOUL.md', { error: err instanceof Error ? err.message : String(err) });
    }

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
  db.prepare("UPDATE agents SET session_started_at = ?, updated_at = ?, config = json_remove(COALESCE(config, '{}'), '$.continuityBrief', '$.scratchpad') WHERE id = ?")
    .run(boundary, boundary, dreamerId);

  // Uniform with the other reset paths: carry any fired-but-undelivered engine
  // event across the boundary. For the Dreamer this is a no-op (its cycle
  // messages are not engine rows), but keeping every reset site consistent
  // means a service agent that ever did hold a deliverable would not lose it.
  rehomeUnclaimedEngineEvents(dreamerId, boundary);

  // Clear accumulated compaction summaries (context items)
  db.prepare('DELETE FROM context_items WHERE agent_id = ?').run(dreamerId);

  // Clear session-loaded tool docs (fire-and-forget, best effort)
  import('../tools/tool-docs.js')
    .then(({ clearSessionLoadedTools }) => clearSessionLoadedTools(dreamerId))
    .catch(() => { /* ignore */ });

  logger.debug('Dreamer session reset for fresh context', { dreamerId });

  const msgId = uuidv4();
  // The cycle message is stored as a plain role='user' row (origin_kind left
  // NULL). It is NOT stamped origin_kind='engine' even though it is engine-
  // synthetic: the assembler lifts engine-origin user rows OUT of the live tail
  // into the EVENTS lane (memory/assembler.ts scopeTo* ), which would divert the
  // Dreamer's actual batch input away from the message it must process. Engine-
  // cycle scoping of the Dreamer's scaffolding is instead handled on the TRIGGER
  // side by the isDreamerAgent skips in loop.ts, so no origin stamp is needed
  // here (P2b). Marking it would require a Dreamer-specific assembler exemption
  // first, which is out of scope for the cadence fix.
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

  // Single wake choke point: record when a batch was last handed to the Dreamer
  // so the continuation sweep never re-arms on top of a live-but-slow batch.
  lastDreamerWakeMs = Date.now();

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

  // Remediation Phase 5: the technique-distillation engine pass rides the
  // same nightly cadence (batched by design, the v1.15.96 constraints live
  // in techniques/distillation.ts). Deliberately NOT a Dreamer handoff: the
  // Dreamer stays strictly memory curation; distillation candidates come
  // from the tracker's outcome record and go straight to the Trainer.
  try {
    const { runDistillationCycle } = await import('../techniques/distillation.js');
    await runDistillationCycle();
  } catch (err) {
    logger.warn('Technique distillation pass failed (non-fatal to dreaming)', {
      error: err instanceof Error ? err.message : String(err),
    });
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
  const allUnprocessed = getUnprocessedConversations();
  if (allUnprocessed.length === 0) {
    logger.info('No unprocessed conversation archives, skipping Dreamer spawn');
    broadcast({ type: 'dream:complete', data: { skipped: true, reason: 'no_archives', ...maintenance } });
    return { dreamerId: null };
  }

  // Step 2.5: Engine-side triage, auto-skip archives that are clearly not
  // worth a model token (tiny conversations, platform-noise-only, etc.).
  // This is the biggest single token win in the Dreamer rewrite: most
  // sub-agent sessions are 5-message question/answer exchanges with
  // nothing to remember, but they used to go through the model anyway.
  const { markConversationProcessed } = await import('./store.js');
  const unprocessed: VaultConversation[] = [];
  let autoSkipped = 0;
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
  if (autoSkipped > 0) {
    logger.info(`Engine triage: auto-skipped ${autoSkipped} trivial archives, ${unprocessed.length} remain for the Dreamer`);
  }
  if (unprocessed.length === 0) {
    logger.info('No archives left after engine triage, Dreamer cycle skipped');
    broadcast({ type: 'dream:complete', data: { skipped: true, reason: 'all_trivial', autoSkipped, ...maintenance } });
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

  broadcast({ type: 'dream:started', data: { mode: config.dreamMode, archives: unprocessed.length, batches: batches.length } });

  const stats = getVaultStats();

  // Step 3: Process batches, wake Dreamer for the first batch
  // Subsequent batches are handled after each complete_task via markDreamerArchivesProcessed
  const firstBatch = batches[0];
  if (!firstBatch) {
    logger.warn('No valid archive batches to process');
    return { dreamerId: null };
  }

  // Ensure permanent Dreamer exists before waking it
  ensureDreamerAgentRunning();

  const dreamerId = getDreamerAgentId();
  const dreamerState = db.prepare(`
    SELECT status,
      (updated_at < datetime('now', '-${DREAMER_STALE_MINUTES} minutes')) AS is_stale
    FROM agents WHERE id = ?
  `).get(dreamerId) as { status: string; is_stale: number } | undefined;

  if (dreamerState?.status === 'working') {
    // RC-15: distinguish a genuinely mid-batch Dreamer from a stuck one; the
    // shared helper resets a corpse (no live run past the staleness window)
    // and leaves a genuinely mid-batch Dreamer alone, in which case we skip
    // the cycle exactly as before.
    if (!resetStuckDreamerIfDead(dreamerId, dreamerState.is_stale === 1)) {
      logger.warn('Dreamer is already running, skipping cycle', { dreamerId, liveInProcess: activeRuns.has(dreamerId) });
      return { dreamerId };
    }
  }

  // Store remaining batches for sequential processing, plus the cycle-
  // reporting state used to write a single dream_reports row when the
  // final batch completes.
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

  // Store the first batch's archive IDs on the Dreamer agent record.
  // CRITICAL: wrap the bound parameter in SQLite's json() function. Without
  // it, json_set treats a TEXT parameter as a literal string value and
  // stores it AS A STRING at $.dreamerArchiveIds. The downstream reader
  // would then iterate the *characters* of that JSON string instead of
  // the array elements, marking nothing as processed and leaving the
  // backlog stuck forever (this was the v1.15.100 "stays at 48" bug).
  db.prepare(`
    UPDATE agents SET config = json_set(COALESCE(config, '{}'), '$.dreamerArchiveIds', json(?))
    WHERE id = ?
  `).run(JSON.stringify(firstBatch.ids), dreamerId);

  // Build cycle message: vault state + archives + instructions
  const cycleMessage = buildDreamerCycleMessage(firstBatch.text, 0, batches.length, stats, profilePath, soulPath, config.dreamMode, unprocessed);

  // P2a: a nightly cycle is now committing to a drain. Open the cycle-in-flight
  // marker so the mid-day continuation sweep may recover this cycle if it
  // stalls, but never START a new one for daytime archives. Cleared at finalize.
  // Setting it here (reached only via runDreamingCycle, the nightly tick's cycle
  // entrypoint) also self-heals a marker leaked by a crashed prior finalize.
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
  // Capped at MAX_RECOVERY_DEPTH, beyond that, splitting further is
  // unlikely to help and we let the error propagate.
  recoveryDepth?: number;

  // Cycle-level reporting state, used by writeDreamReportForCycle when
  // the final batch completes. Pre-2026-04-30 createDreamReport was defined
  // but never called, so the dashboard's "Dreams" tab was permanently
  // empty no matter how long the platform had been running.
  cycleStartedAtMs: number;
  archivesProcessedThisCycle: number;
  autoSkippedThisCycle: number;
  totalArchivesAtStart: number;
  maintenanceAtStart: { pruned: number; decayed: number; unpinned: number; agedOut: number };
  vaultStatsBefore: ReturnType<typeof getVaultStats>;
}

const MAX_RECOVERY_DEPTH = 3;

// FA-V4: how many terminal-but-not-'complete' Dreamer passes an archive may
// take before it is poisoned (parked + escalated) instead of retried forever.
// Context-overflow has its own recovery path (recoverDreamerFromContextOverflow);
// this counter is for genuine 'blocked'/'fallen' completions where the model
// keeps giving up on the same archive. Bounded and loud, not a blind retry.
const MAX_DREAM_ATTEMPTS = 3;

const pendingBatches = new Map<string, PendingBatchState>();

/**
 * Write a dream_reports row summarizing the cycle. Called when the final
 * batch completes (or when a cycle is force-finalized due to abort).
 * Pre-2026-04-30 createDreamReport was defined but never invoked, so the
 * dashboard's "Dreams" tab was permanently empty no matter how long the
 * platform had been running. This is the missing link.
 */
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
      `Batches: ${state.batches.length}. Duration: ${Math.round(durationMs / 1000)}s. Mode: ${state.config.dreamMode}.`,
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
      dreamMode: state.config.dreamMode,
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

/**
 * Finalize a dream cycle: write the report, post the single per-cycle notice to
 * the primary, tear down the in-memory state, and broadcast completion. `state`
 * may be null when the in-memory cycle counters were lost to a mid-cycle restart
 * and the stateless DB-driven continuation finished the remaining archives, in
 * which case a minimal (labeled) report is written instead of the rich one.
 */
async function finalizeDreamCycle(primaryId: string, state: PendingBatchState | null): Promise<void> {
  if (state) {
    // Pre-2026-04-30 the cycle ended silently with no record; the Dreams tab
    // was empty even after months of dreaming. This writes the missing row.
    writeDreamReportForCycle(state, 'complete');
  } else {
    writeResumedDreamReport();
  }

  // D-A step 4, Dreamer rule (owner decision, repeated): the Dreamer's output is the
  // VAULT (recall/retrieval injection) and it must NEVER message the primary agent.
  // The old per-cycle "Tidied up memory tonight... Nothing needs your attention."
  // notice was exactly that, a message injected into the primary's context/EVENTS
  // lane, and it is removed here. The REASON it existed (record that a cycle ran, and
  // surface it to the owner) is fully preserved WITHOUT touching the primary: the
  // cycle is recorded to dream_reports via writeDreamReportForCycle/writeResumedDream-
  // Report above (the Dreams tab), and the owner-facing completion signal is the
  // dream:complete broadcast below. No signal, waking OR awareness, is emitted to the
  // primary. Distilled memories reached the vault during the cycle via the Dreamer's
  // own tools; that IS the injection path the primary reads.

  pendingBatches.delete(primaryId);
  // P2a: the drain is finished, close the cycle-in-flight marker. Reached from
  // both the in-memory-state path and the resumed-after-restart (state === null)
  // path, so a cycle started tonight can no longer be re-armed by the mid-day
  // sweep. The next nightly tick opens a fresh marker for the next drain.
  setDreamCycleOpen(false);
  logger.info('All Dreamer batches complete', { totalBatches: state?.batches.length ?? 'resumed' });
  broadcast({ type: 'dream:complete', data: { batches: state?.batches.length ?? 0 } });
}

/**
 * FA-V4: minimal dream report for the case where a mid-cycle restart wiped the
 * in-memory cycle counters but the stateless continuation still finished the
 * remaining archives. Per-archive totals are unknown, so they are recorded as 0
 * and the reportText says so, rather than fabricating a number.
 */
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
      dreamMode: config.dreamMode,
      modelId: config.modelId ?? undefined,
    });
    logger.info('Resumed dream report written (post-restart continuation)');
  } catch (err) {
    logger.warn('Failed to write resumed dream report', { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * FA-V4 stateless continuation. Re-derive the next Dreamer batch straight from
 * the DB (remaining is_processed=0 AND poisoned=0 archives) instead of trusting
 * the in-memory pendingBatches map, so a lost/empty map (tsx reload, crash,
 * self-update restart) never abandons a multi-batch cycle. Returns true if a
 * batch was woken, false if nothing remains (caller finalizes).
 */
async function wakeNextBatchFromDb(primaryId: string, state: PendingBatchState | null): Promise<boolean> {
  const db = getDb();

  // Event-loop discipline (2026-07-19): only ONE batch is used per call
  // (batches[0] below), so never load the whole queue's message blobs, the
  // full load once froze every in-flight request for minutes on a day-sized
  // queue. Walk the metadata list ASC and load content per row: trivial rows
  // are marked processed as before; non-trivial rows accumulate ONLY until we
  // hold comfortably more than one batch's worth (2x the context window by
  // raw token_count is a guaranteed superset of batches[0], whose budget is
  // always below one context window), then stop. Batch composition is
  // identical to the full-queue result because order and budget are unchanged.
  const { markConversationProcessed, getUnprocessedConversationMeta, getUnprocessedConversationById } = await import('./store.js');
  const queueMeta = getUnprocessedConversationMeta();
  if (queueMeta.length === 0) return false;

  const modelId = state?.modelId ?? getDreamingConfig().modelId ?? getDefaultDreamModel();
  if (!modelId) {
    logger.warn('No model available to continue dream cycle from DB');
    return false;
  }
  const modelRow = db.prepare('SELECT context_window FROM models WHERE id = ?').get(modelId) as
    | { context_window: number } | undefined;
  const contextWindow = modelRow?.context_window ?? 32000;

  // Bounded per-row load: triage trivials (marked processed, exactly the old
  // behavior) and collect non-trivial rows until the raw token superset bound.
  const remaining: VaultConversation[] = [];
  let subsetTokens = 0;
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
  if (remaining.length === 0) return false;

  const batches = batchArchives(remaining, contextWindow);
  const batch = batches[0];
  if (!batch) return false;

  const dreamerId = getDreamerAgentId();
  // json(?) required so SQLite stores the array AS JSON, not as a quoted
  // string, see the matching note in runDreamingCycle.
  db.prepare(`
    UPDATE agents SET config = json_set(COALESCE(config, '{}'), '$.dreamerArchiveIds', json(?))
    WHERE id = ?
  `).run(JSON.stringify(batch.ids), dreamerId);

  const stats = state?.stats ?? getVaultStats();

  // Keep the in-memory state coherent so reporting + any later in-memory
  // sequencing still work. When state was present but its precomputed batches
  // were exhausted, append the freshly-derived batch and point at it (the next
  // completion re-enters this DB path). When state was lost (restart), rebuild a
  // minimal one; the report it eventually writes is the labeled partial above.
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

  const profilePath = path.join(os.homedir(), '.dojo', 'prompts', 'USER.md');
  const soulPath = path.join(os.homedir(), '.dojo', 'prompts', 'SOUL.md');
  // batchIndex 0 / totalBatches 1 keeps the "batch X of N" note off (N is not
  // known statelessly). The batch text carries every archive anyway.
  const cycleMessage = buildDreamerCycleMessage(
    batch.text, 0, 1, stats, profilePath, soulPath, (state?.config ?? getDreamingConfig()).dreamMode, [],
  );
  wakeupDreamer(cycleMessage);
  logger.info('Dreamer woken for next batch (stateless DB continuation)', {
    dreamerId, archivesInBatch: batch.ids.length, remaining: queueMeta.length, resumedAfterRestart: !state,
  });
  return true;
}

/**
 * After the Dreamer completes a batch, advance the cycle. Two paths:
 *   1. Precomputed batches remain in the in-memory state (normal multi-batch
 *      flow AND the context-overflow recovery's shrunk sub-batch sequencing,
 *      which relies on state.batches): advance through them as before.
 *   2. Precomputed batches exhausted OR the in-memory map was lost to a restart:
 *      re-derive the next batch from the DB so the cycle is never abandoned
 *      (FA-V4 stateless continuation). Finalize only when the DB says nothing
 *      remains.
 */
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

    const profilePath = path.join(os.homedir(), '.dojo', 'prompts', 'USER.md');
    const soulPath = path.join(os.homedir(), '.dojo', 'prompts', 'SOUL.md');

    try {
      const dreamerId = getDreamerAgentId();
      const db = getDb();

      // Update archive IDs on the permanent Dreamer record for this batch.
      // json(?) is required so SQLite stores the array AS JSON, not as a
      // quoted string, see the matching note in runDreamingCycle.
      db.prepare(`
        UPDATE agents SET config = json_set(COALESCE(config, '{}'), '$.dreamerArchiveIds', json(?))
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
    return;
  }

  // Path 2: precomputed batches exhausted, or the map was lost (restart).
  const woke = await wakeNextBatchFromDb(primaryId, state ?? null);
  if (!woke) {
    await finalizeDreamCycle(primaryId, state ?? null);
  }
}

// ── Mark Dreamer Archives as Processed ──

/**
 * Called when the Dreamer agent ends a batch on ANY terminal status (FA-V4).
 *
 *   'complete'          -> the Dreamer reviewed the whole batch: mark every
 *                          assigned archive processed (existing behavior).
 *   'blocked'/'fallen'  -> the batch was NOT distilled: do NOT mark it processed
 *                          (never mark an archive the Dreamer did not distill).
 *                          Bump each archive's attempt counter and poison any
 *                          that have now failed MAX_DREAM_ATTEMPTS times so the
 *                          engine stops retrying it forever and surfaces it via
 *                          the DREAM_POISONED diagnostic.
 *
 * Either way, advance the cycle (spawnNextDreamerBatch) so a non-complete batch
 * no longer stalls the whole night (pre-fix the chain advanced only on 'complete').
 *
 * dreamerAgentId may be either the permanent 'dreamer' ID or a legacy temporary agent ID.
 */
export function markDreamerArchivesProcessed(
  dreamerAgentId: string,
  status: 'complete' | 'fallen' | 'blocked' = 'complete',
): void {
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
    let archiveIds = config.dreamerArchiveIds as string[] | string | undefined;

    // Defensive guard for the v1.15.100 bug: dreamerArchiveIds was
    // historically stored AS A STRING (the JSON-encoded array literally
    // serialized into a string field) because json_set was called without
    // wrapping the parameter in json(). If we encounter that legacy shape,
    // parse it back into an array. Without this, we'd iterate the string's
    // characters and "Mark N archives" would log a character count while
    // updating zero rows, exactly the symptom that left users stuck with
    // a backlog that never decreased.
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
      // No batch attribution on the record (a restart may have cleared config
      // before the map was rebuilt). Still try to continue the cycle from the
      // DB so it is not abandoned.
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
      // FA-V4: a non-'complete' terminal pass did NOT distill this batch. Do not
      // mark it processed. Bump each archive's attempt counter and poison any
      // that have crossed MAX_DREAM_ATTEMPTS so we stop retrying it forever.
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

    // Bump the per-cycle counter so the eventual dream report reflects the
    // archives the Dreamer actually distilled end-to-end (only 'complete'
    // passes distill; a blocked/fallen pass contributes 0).
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
  // the same, it now points at the first sub-batch.
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
  // marks the right archives as processed. json(?) required, see note
  // in runDreamingCycle.
  db.prepare(`
    UPDATE agents SET config = json_set(COALESCE(config, '{}'), '$.dreamerArchiveIds', json(?))
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
  });

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

// ── Nightly Engine Maintenance Jobs (no Dreamer involved) ──
//
// Ride the same nightly window as the dreaming cycle, and run BEFORE the
// Dreamer is woken: the disk reclaim's VACUUM is guarded on "no agent turn
// active", which is guaranteed at the top of the window but not once the
// Dreamer agent is mid-cycle. Each job is independently best-effort; a
// failure is logged and retried the next night, and never blocks dreaming.
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

// ── Dreamer Continuation Sweep (RC-15 unstick) ──

/**
 * Reset a Dreamer whose 'working' status is a corpse: no live in-process run
 * AND updated_at past the staleness window (a live run holds an activeRuns
 * entry and keeps updated_at fresh via the 30s heartbeat). Returns true when
 * the caller may proceed (corpse reset, or the row was not stuck at all);
 * false when the Dreamer is genuinely mid-batch and must be left alone.
 * Shared by runDreamingCycle (nightly) and sweepDreamerHealth (5-min hook).
 */
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

/**
 * RC-15 follow-up (owner ruled 2026-07-16): the mid-day unstick hook. Called
 * from the runtime's periodic stuck-agent recovery sweep so a Dreamer stall
 * recovers within minutes instead of waiting for the nightly window. Two
 * checks, both cheap and idempotent:
 *   1. corpse reset: a 'working' row with no live run past the staleness window;
 *   2. continuation re-arm: unprocessed archives with an idle Dreamer and no
 *      recent wake (runDreamerContinuationSweep's own guards).
 * Never touches a genuinely live batch.
 */
export async function sweepDreamerHealth(): Promise<void> {
  try {
    if (getDreamingConfig().dreamMode === 'off') return;
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

/**
 * Re-arm the stateless DB-driven continuation when a prior cycle's batch
 * advance was dropped. The cycle normally advances only via a terminal
 * complete_task (spawner -> markDreamerArchivesProcessed -> spawnNextDreamer-
 * Batch); if that never fires (a Dreamer that died mid-cycle, a lost in-memory
 * map after a restart), unprocessed archives can sit idle until the next nightly
 * window. This sweep re-arms spawnNextDreamerBatch when, and only when:
 *   - dreaming is enabled and setup is complete,
 *   - non-poisoned, non-trivial archives still remain,
 *   - the Dreamer is idle (status not 'working' AND no live in-process run), and
 *   - no batch was woken within the quiet window (never stack on a live cycle).
 * spawnNextDreamerBatch -> wakeNextBatchFromDb re-derives the next batch from the
 * DB (FA-V4), so calling it here is idempotent and safe if a cycle is in fact
 * already draining the same archives. Deliberately no new timer: this piggybacks
 * the nightly scheduler tick below.
 */
export async function runDreamerContinuationSweep(): Promise<void> {
  try {
    if (getDreamingConfig().dreamMode === 'off') return;
    if (!isSetupCompleted()) return;

    const primaryId = getPrimaryAgentId();
    if (!primaryId) return;

    // P2a cycle-in-flight gate (owner rule: dreamer cycles are once per night).
    // This mid-day sweep RECOVERS a stalled nightly cycle; it must never START a
    // fresh drain for archives produced during the day. A nightly cycle opens the
    // marker when it commits to a drain (runDreamingCycle) and finalizeDreamCycle
    // clears it; with no cycle open, today's archives wait for tonight's window.
    // Checked BEFORE any other work so a closed marker costs one config read.
    if (!isDreamCycleOpen()) return;

    const dreamerId = getDreamerAgentId();
    if (activeRuns.has(dreamerId)) return; // a batch is live in this process
    const db = getDb();
    const row = db.prepare('SELECT status FROM agents WHERE id = ?').get(dreamerId) as { status: string } | undefined;
    if (row?.status === 'working') return; // genuinely mid-batch (staleness handled by runDreamingCycle)

    // Marker open, Dreamer idle. Non-trivial work must remain; trivial archives
    // are left for the normal triage to mark processed so the sweep never wakes
    // the Dreamer to discard junk. If NOTHING non-trivial remains, a prior
    // finalize crashed (or a restart landed) after the last batch was filed but
    // before the marker was cleared: the marker leaked open. Finalize now to
    // close it instead of spinning on nothing every sweep.
    // Event-loop discipline (2026-07-19): this runs on a 5-minute tick, so it
    // must NEVER load the whole queue's message blobs (a day's accumulation is
    // hundreds of megabyte-scale rows, and the full load froze every request
    // in flight: minutes-long dashboard loads). Walk the metadata list and
    // load content ONE row at a time, stopping at the first non-trivial hit.
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
    await spawnNextDreamerBatch(primaryId);
  } catch (err) {
    logger.warn('Dreamer continuation sweep failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
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
    // The nightly ENGINE maintenance (disk reclaim + summary rebuild) still
    // needs its window even when dreaming is off, so the timer is scheduled
    // regardless; runDreamingCycle itself no-ops in 'off' mode.
    logger.info('Dreaming is disabled; scheduling nightly window for engine maintenance only');
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
    // RC-15: safety net on the same tick. If the cycle above (or a prior one)
    // left archives unprocessed with an idle Dreamer, re-arm the continuation.
    // Its guards make it a no-op whenever the cycle just woke a batch.
    await runDreamerContinuationSweep();
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
