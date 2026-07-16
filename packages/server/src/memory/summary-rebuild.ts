// ════════════════════════════════════════════════════════════════════════
// Nightly contaminated-summary rebuild (D20, owner approved 2026-07)
//
// Before the compaction noise filter existed (isNonConversationForSummary),
// live compaction folded inter-agent plumbing (Dreamer cycle scaffolding,
// PM pokes, inbound A2A envelopes, embedded SOUL prompts) into the context
// summaries, and the summarizer's deterministic-truncation fallback stored
// RAW message text (role tags, [SOURCE: …] envelopes) verbatim. Those
// contaminated summaries are embedded + FTS-indexed, so they pollute memory
// search, and condensation carries them upward into depth-1/2 summaries.
//
// This module regenerates flagged summaries from their DAG descendants
// through the CURRENT summarization path and filter, a bounded batch per
// night so the cost stays a few cents. It is:
//   - self-limiting: at most NIGHTLY_SUMMARY_REBUILD_LIMIT model rebuilds
//     per run; once the stock is clean the nightly scan finds nothing.
//   - idempotent + crash-safe: there is no "done" flag anywhere. A summary
//     is clean purely by virtue of its content no longer matching the
//     contamination taxonomy; a crash mid-batch just means the next run
//     re-scans and picks up where the content says to.
//   - depth-ordered: leaves rebuild before condensed parents, and a
//     condensed summary is deferred while any of its children still match,
//     so re-cleaned content flows upward instead of re-condensing noise.
//
// This is deliberately NOT a boot migration: rebuilding needs LLM calls and
// embedding refreshes; doing ~180 of those at startup would block boot for
// many minutes and burn a visible chunk of money in one shot.
// ════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { isPlatformNoise } from './platform-noise.js';
import {
  isNonConversationForSummary,
  scrubTechniqueContentForSummary,
  condenseToolJsonForSummary,
  resolveSummaryWriterModel,
  NO_CONVERSATION_PLACEHOLDER,
  SUMMARY_TARGET_TOKENS,
} from './compaction.js';
import {
  getSummaryChildren,
  getDescendantMessages,
  updateSummaryContent,
  type Summary,
} from './dag.js';
import { generateSummary } from './summarize.js';
import { stripOpenLoopsSection } from './open-loops.js';
import { refreshEmbedding } from './embeddings.js';
import { estimateTokens } from './store.js';
import { summaryPartyTag } from './party-label.js';
import type { Message } from '@dojo/shared';

const logger = createLogger('summary-rebuild');

/** Max LLM/placeholder rebuilds per nightly run. ~30 keeps the nightly cost
 *  at a few cents on the cheap summary-writer model and clears a ~180-summary
 *  backlog in about a week. Skipped/deferred summaries do NOT consume slots. */
export const NIGHTLY_SUMMARY_REBUILD_LIMIT = 30;

// ── Detection taxonomy ──
//
// Two layers, both derived from the SAME taxonomy the live filter enforces
// on summary INPUT (memory/platform-noise.ts + the A2A inbound markers in
// memory/compaction.ts):
//
// (1) Content-wide structural markers. These engine-generated envelopes and
//     scaffolding strings can only be present in a summary because the noisy
//     source rows were fed to (or echoed by) the summarizer. A summary
//     regenerated through the current filter cannot re-acquire them, which is
//     what makes "clean = no longer matches" a terminating condition.
// (2) Per-line raw-noise check. The deterministic-truncation fallback stored
//     raw chunk text ("[ROLE · party] content" lines) verbatim, so we strip a
//     leading role tag from each line and re-apply the live message-level
//     filter to what remains.
const SUMMARY_CONTAMINATION_PATTERNS: RegExp[] = [
  /\[A2A:/i,
  /\[SOURCE: (AGENT MESSAGE FROM|GROUP BROADCAST FROM|PM AGENT POKE|SUB-AGENT COMPLETION|TRACKER TASK|AGENT HEALTH ALERT|AGENT NOTICE|HEALER|SCHEDULER|SYSTEM)/i,
  /═══ DREAM CYCLE ═══/,
  /═══ COMPRESSED HISTORY/,
  /Vault state: \d+ entries/,
  /Process the archives below/i,
  /Full archive list \(\d+ total\)/i,
  /This is batch \d+ of \d+\b/i,
  /You are the (Dreamer|Trainer|Healer|PM|Imaginer)\b/i,
  /\[CONTINUITY BRIEF/i,
  /── New Session ──/,
  /\[New Session\]/i,
];

// "This conversation consists solely of tool calls…" filler summaries. The
// phrase alone is not enough to flag (a legitimate rebuild of a narration-rich
// chunk could phrase things similarly); the summary is filler only when its
// descendants genuinely carry no conversational prose, in which case the
// deterministic placeholder replaces it (no LLM call, guaranteed convergence).
const TOOL_ONLY_FILLER_RE = /consists\s+(?:solely|entirely|only|purely)\s+of\s+(?:\w+\s+)?tool\s+calls/i;

// Leading "[ROLE]" / "[ROLE · party]" tag on a raw-embedded line.
const ROLE_TAG_RE = /^\s*\[(USER|ASSISTANT|SYSTEM|TOOL)\b[^\]]*\]\s*/i;

// Minimum conversational-prose chars for a span to be worth an LLM summary.
// Below this, the span is tool traffic/plumbing and gets the placeholder.
const MIN_PROSE_CHARS = 120;

function lineIsRawNoise(line: string): boolean {
  const stripped = line.replace(ROLE_TAG_RE, '');
  return isPlatformNoise(stripped) || isNonConversationForSummary(stripped);
}

/** True when summary CONTENT carries inter-agent/platform noise markers. */
export function isContaminatedSummaryContent(content: string | null | undefined): boolean {
  if (!content) return false;
  for (const pat of SUMMARY_CONTAMINATION_PATTERNS) {
    if (pat.test(content)) return true;
  }
  for (const line of content.split('\n')) {
    if (lineIsRawNoise(line)) return true;
  }
  return false;
}

// ── Summarizer input (same shape as runLeafCompaction / runCondensation) ──

function buildLeafInput(messages: Message[]): string {
  return messages
    .filter(m => !isNonConversationForSummary(m.content))
    .map(m => {
      const role = m.role.toUpperCase();
      const party = summaryPartyTag(m);
      const tag = party ? `${role} · ${party}` : role;
      return `[${tag}] ${condenseToolJsonForSummary(scrubTechniqueContentForSummary(m.content))}`;
    })
    .join('\n\n---\n\n');
}

function buildCondensedInput(children: Summary[]): string {
  return children
    .map(s => `<summary id="${s.id}" depth="${s.depth}" earliest="${s.earliestAt}" latest="${s.latestAt}">\n${s.content}\n</summary>`)
    .join('\n\n');
}

/** Conversational prose remaining in a leaf input once role tags and the
 *  condensed tool one-liners ("(called tool …)" / "(tool result: …)") are
 *  stripped. Used to decide placeholder vs. LLM rebuild. */
function proseChars(leafInput: string): number {
  let total = 0;
  for (const rawLine of leafInput.split('\n')) {
    const line = rawLine.replace(ROLE_TAG_RE, '').trim();
    if (line.length === 0 || line === '---') continue;
    if (/^\(called tool /.test(line) || /^\(tool result/.test(line)) continue;
    total += line.length;
  }
  return total;
}

// ── Convergence guards ──

/** Detect generateSummary's deterministic-truncation fallback (model call
 *  failed or output stayed oversized): the "summary" is then an echo of the
 *  raw input, exactly the failure mode that created this contamination in
 *  the first place. On fallback we SKIP the update and retry another night
 *  rather than replace an old LLM summary with a raw dump. */
function looksLikeSummarizerFallback(input: string, output: string): boolean {
  if (output.includes(' tokens truncated ...]')) return true;
  const probe = input.trim().slice(0, 80);
  return probe.length >= 80 && output.trim().startsWith(probe);
}

/** Deterministic finishing pass: drop any output line that still matches the
 *  taxonomy (e.g. a marker quoted out of a kept tool-result one-liner). This
 *  guarantees a rebuilt summary no longer matches, so the mechanism cannot
 *  loop on the same summary forever. */
function scrubResidualContamination(text: string): { text: string; removedLines: number } {
  const lines = text.split('\n');
  const kept: string[] = [];
  let removed = 0;
  for (const line of lines) {
    const dirty = SUMMARY_CONTAMINATION_PATTERNS.some(p => p.test(line)) || lineIsRawNoise(line);
    if (dirty) removed++;
    else kept.push(line);
  }
  return { text: kept.join('\n').trim(), removedLines: removed };
}

// ── Scan ──

interface SummaryScanRow {
  id: string;
  agent_id: string;
  depth: number;
  kind: string;
  content: string;
  earliest_at: string;
  latest_at: string;
  created_at: string;
}

interface FlaggedSummary {
  id: string;
  agentId: string;
  depth: number;
  kind: string;
  content: string;
  earliestAt: string;
  latestAt: string;
  reason: 'contaminated' | 'tool_only_filler';
}

/** Scan ALL summaries and return the ones still matching the taxonomy,
 *  ordered depth-ASC then oldest-first so leaves rebuild before parents. */
export function findContaminatedSummaries(): FlaggedSummary[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, agent_id, depth, kind, content, earliest_at, latest_at, created_at
    FROM summaries
    ORDER BY depth ASC, created_at ASC
  `).all() as SummaryScanRow[];

  const flagged: FlaggedSummary[] = [];
  for (const row of rows) {
    if (isContaminatedSummaryContent(row.content)) {
      flagged.push(toFlagged(row, 'contaminated'));
      continue;
    }
    if (row.kind === 'leaf' && TOOL_ONLY_FILLER_RE.test(row.content) && row.content !== NO_CONVERSATION_PLACEHOLDER) {
      // Filler only if the descendants genuinely lack conversational prose;
      // this keeps the predicate false on any content the rebuild can write.
      try {
        const msgs = getDescendantMessages(row.id);
        if (msgs.length > 0 && proseChars(buildLeafInput(msgs)) < MIN_PROSE_CHARS) {
          flagged.push(toFlagged(row, 'tool_only_filler'));
        }
      } catch { /* best effort; leave unflagged */ }
    }
  }
  return flagged;
}

function toFlagged(row: SummaryScanRow, reason: FlaggedSummary['reason']): FlaggedSummary {
  return {
    id: row.id,
    agentId: row.agent_id,
    depth: row.depth,
    kind: row.kind,
    content: row.content,
    earliestAt: row.earliest_at,
    latestAt: row.latest_at,
    reason,
  };
}

// ── Rebuild one summary ──

type RebuildOutcome =
  | 'rebuilt'       // regenerated through the current path + filter
  | 'placeholder'   // descendants were all noise/tool traffic; minimal placeholder written
  | 'deferred'      // condensed summary whose children are not clean yet; next night
  | 'skipped';      // cannot rebuild safely (e.g. source messages deleted, summary is the sole copy)

async function rebuildOneSummary(flag: FlaggedSummary, modelId: string): Promise<RebuildOutcome> {
  let input: string;
  let depth: number;
  let targetTokens: number;

  if (flag.kind === 'leaf') {
    const msgs = getDescendantMessages(flag.id);
    if (msgs.length === 0) {
      // Source messages were deleted; this summary is the sole remaining copy
      // of that span. Never overwrite the only copy of anything.
      logger.warn('Summary rebuild skipped: source messages gone, summary is the sole copy', {
        summaryId: flag.id, reason: flag.reason,
      }, flag.agentId);
      return 'skipped';
    }
    input = buildLeafInput(msgs);
    if (input.trim().length === 0 || proseChars(input) < MIN_PROSE_CHARS) {
      // Everything in the span is plumbing/tool traffic. Same deterministic
      // placeholder the live path writes for all-noise chunks. The raw rows
      // still exist in the messages table, so nothing is lost.
      writeRebuiltContent(flag, NO_CONVERSATION_PLACEHOLDER);
      return 'placeholder';
    }
    depth = 0;
    targetTokens = SUMMARY_TARGET_TOKENS.leaf;
  } else {
    const children = getSummaryChildren(flag.id);
    if (children.length === 0) {
      logger.warn('Summary rebuild skipped: condensed summary has no children rows', {
        summaryId: flag.id,
      }, flag.agentId);
      return 'skipped';
    }
    // Children must be clean first; condensing contaminated children would
    // just re-absorb the noise. Depth ordering makes this resolve over nights.
    if (children.some(c => isContaminatedSummaryContent(c.content))) {
      return 'deferred';
    }
    const allPlaceholders = children.every(c => c.content === NO_CONVERSATION_PLACEHOLDER);
    if (allPlaceholders) {
      writeRebuiltContent(flag, NO_CONVERSATION_PLACEHOLDER);
      return 'placeholder';
    }
    input = buildCondensedInput(children);
    depth = flag.depth;
    targetTokens = SUMMARY_TARGET_TOKENS.condensed;
  }

  const result = await generateSummary({
    content: input,
    depth,
    targetTokens,
    agentId: flag.agentId,
    modelId,
  });

  if (!result.text || result.text.trim().length === 0) {
    logger.warn('Summary rebuild produced empty output; leaving summary for a later night', {
      summaryId: flag.id,
    }, flag.agentId);
    return 'skipped';
  }
  if (looksLikeSummarizerFallback(input, result.text)) {
    logger.warn('Summary rebuild hit the deterministic-truncation fallback (model unavailable or output oversized); leaving summary for a later night', {
      summaryId: flag.id, modelId,
    }, flag.agentId);
    return 'skipped';
  }

  const scrubbed = scrubResidualContamination(result.text);
  if (scrubbed.removedLines > 0) {
    logger.info('Summary rebuild scrubbed residual noise lines from regenerated text', {
      summaryId: flag.id, removedLines: scrubbed.removedLines,
    }, flag.agentId);
  }
  // RC-2: the depth-0 contract can emit a fenced OPEN-LOOPS section. A rebuild
  // regenerates from originals but does NOT re-upsert structured rows (those are
  // owned by live compaction), so strip the section here so it never leaks back
  // into a rebuilt summary as immortal prose. No-op when absent.
  const deLooped = stripOpenLoopsSection(scrubbed.text);
  const finalText = deLooped.length > 0 ? deLooped : NO_CONVERSATION_PLACEHOLDER;

  writeRebuiltContent(flag, finalText);
  return finalText === NO_CONVERSATION_PLACEHOLDER ? 'placeholder' : 'rebuilt';
}

/** Persist the regenerated content. The 083 AFTER UPDATE OF content triggers
 *  keep summaries_fts in sync; refreshEmbedding drops the stale embedding row
 *  and re-embeds the new text (best-effort; the scheduled embedding backfill
 *  re-embeds any summary left without a row if the embedder is down). */
function writeRebuiltContent(flag: FlaggedSummary, text: string): void {
  updateSummaryContent(flag.id, text, estimateTokens(text));
  refreshEmbedding('summary', flag.id, flag.agentId, text);
}

// ── Nightly batch runner ──

export interface SummaryRebuildStats {
  flaggedBefore: number;
  rebuilt: number;
  placeholders: number;
  deferred: number;
  skipped: number;
  remainingAfter: number;
}

let rebuildRunning = false;

/**
 * Run one bounded rebuild batch. Called nightly from the vault maintenance
 * window (vault/maintenance.ts), and callable directly on a dev box to run
 * one batch immediately for verification.
 *
 * opts.limit caps LLM/placeholder rebuilds this run (deferred/skipped items
 * cost nothing and do not consume slots). opts.modelId overrides the writer
 * model (default: same resolution as live compaction, cheap text model).
 */
export async function runSummaryRebuildBatch(opts?: { limit?: number; modelId?: string }): Promise<SummaryRebuildStats> {
  const limit = opts?.limit ?? NIGHTLY_SUMMARY_REBUILD_LIMIT;
  const empty: SummaryRebuildStats = { flaggedBefore: 0, rebuilt: 0, placeholders: 0, deferred: 0, skipped: 0, remainingAfter: 0 };

  if (rebuildRunning) {
    logger.warn('Summary rebuild already running, skipping this invocation');
    return empty;
  }
  rebuildRunning = true;
  try {
    const flagged = findContaminatedSummaries();
    if (flagged.length === 0) {
      logger.info('Summary rebuild complete: no contaminated summaries remain');
      return empty;
    }

    const modelId = opts?.modelId ?? resolveSummaryWriterModel('summary-rebuild');
    if (!modelId) {
      logger.warn('Summary rebuild: no text-capable model available, retrying next night', { flagged: flagged.length });
      return { ...empty, flaggedBefore: flagged.length, remainingAfter: flagged.length };
    }

    const stats: SummaryRebuildStats = { ...empty, flaggedBefore: flagged.length };
    for (const flag of flagged) {
      if (stats.rebuilt + stats.placeholders >= limit) break;
      try {
        const outcome = await rebuildOneSummary(flag, modelId);
        if (outcome === 'rebuilt') stats.rebuilt++;
        else if (outcome === 'placeholder') stats.placeholders++;
        else if (outcome === 'deferred') stats.deferred++;
        else stats.skipped++;
      } catch (err) {
        stats.skipped++;
        logger.warn('Summary rebuild failed for one summary; will retry a later night', {
          summaryId: flag.id,
          error: err instanceof Error ? err.message : String(err),
        }, flag.agentId);
      }
    }

    stats.remainingAfter = findContaminatedSummaries().length;
    logger.info('Summary rebuild nightly batch done', { ...stats, limit, modelId });
    if (stats.remainingAfter === 0) {
      logger.info('Summary rebuild complete: contaminated summary stock fully cleaned');
    }
    return stats;
  } finally {
    rebuildRunning = false;
  }
}
