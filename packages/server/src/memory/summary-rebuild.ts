// Nightly contaminated-summary rebuild: regenerates flagged summaries (inter-agent plumbing or raw message text that
// reached them) from their DAG descendants through the CURRENT summarization path and filter.
// Self-limiting (a clean stock finds nothing, no per-night count) and idempotent + crash-safe: there is no "done"
// flag, a summary is clean because its content no longer matches the taxonomy. Leaves rebuild before condensed
// parents, which wait while any child still matches. Deliberately NOT a boot migration: it needs LLM calls and
// embedding refreshes that would block boot.

import { NEW_SESSION_DIVIDER, A2A_INBOUND_ANYWHERE_RE, SOURCE_ENVELOPE_ANYWHERE_RE,
  NEW_SESSION_BRACKET_ANYWHERE_RE } from '@dojo/shared';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { isPlatformNoise } from './platform-noise.js';
// Its own module: this file is the thing being measured, not the measurer.
import { recordCleanStock, countSummaryStock } from './summary-clean-stock.js';
import {
  isNonConversationForSummary,
  buildLeafSummaryInput,
  NO_CONVERSATION_PLACEHOLDER,
} from './compaction.js';
import { pickWriter } from './writer.js';
import { summaryTargetTokens, mergeTargetTokens } from './summary-target.js';
import { modelCharsPerToken } from '../services/token-density.js';
import {
  getSummaryChildren,
  getDescendantMessages,
  updateSummaryContent,
} from './dag.js';
import { generateSummary, condensedSummaryInput } from './summarize.js';
import { rebuildLegacyMixedNotes, type LegacyRebuildStats } from './legacy-notes-rebuild.js';
import { rebuildGuard, waitReason } from './rebuild-signals.js';
import { refreshEmbedding } from './embeddings.js';
import { estimateTokens } from './budget.js';

const logger = createLogger('summary-rebuild');

// Two layers, both from the taxonomy the live filter enforces on summary INPUT (`memory/platform-noise.ts` and the
// A2A inbound markers in `memory/compaction.ts`): (1) content-wide envelope/scaffolding markers a summary regenerated
// through the current filter cannot re-acquire, which makes "clean = no longer matches" terminate; (2) a per-line
// check that strips a leading role tag and re-applies the message-level filter.
const SUMMARY_CONTAMINATION_PATTERNS: RegExp[] = [
  // Both forms come from the same prefix arrays as platform-noise.ts. The bare poke form is kept ON PURPOSE: a legacy
  // row with no sender must still count as contamination.
  A2A_INBOUND_ANYWHERE_RE,
  SOURCE_ENVELOPE_ANYWHERE_RE,
  /\[SOURCE: PM AGENT POKE/i,
  /═══ DREAM CYCLE ═══/,
  /═══ COMPRESSED HISTORY/,
  /Vault state: \d+ entries/,
  /Process the archives below/i,
  /Full archive list \(\d+ total\)/i,
  /This is batch \d+ of \d+\b/i,
  /You are the (Dreamer|Trainer|Healer|PM|Imaginer)\b/i,
  /\[CONTINUITY BRIEF/i,
  // Shape from @dojo/shared; membership in this contamination list stays local.
  new RegExp(NEW_SESSION_DIVIDER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  NEW_SESSION_BRACKET_ANYWHERE_RE,
];

// "This conversation consists solely of tool calls" filler: flagged only when the descendants really carry no
// conversational prose (the phrase alone is not enough); the deterministic placeholder replaces it, no LLM call.
const TOOL_ONLY_FILLER_RE = /consists\s+(?:solely|entirely|only|purely)\s+of\s+(?:\w+\s+)?tool\s+calls/i;

// Leading "[ROLE]" / "[ROLE · party]" tag on a raw-embedded line.
const ROLE_TAG_RE = /^\s*\[(USER|ASSISTANT|SYSTEM|TOOL)\b[^\]]*\]\s*/i;

// Below this many conversational-prose chars a span is tool traffic and gets the placeholder.
const MIN_PROSE_CHARS = 120;

function lineIsRawNoise(line: string): boolean {
  const stripped = line.replace(ROLE_TAG_RE, '');
  return isPlatformNoise(stripped) || isNonConversationForSummary(stripped);
}

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

// The one leaf-input builder (compaction's): this module replays the summariser's transformation, so a second copy
// would replay a summariser that does not exist.
const buildLeafInput = buildLeafSummaryInput;

/** Conversational prose left in a leaf input once role tags and the condensed tool one-liners are stripped;
 *  decides placeholder vs. LLM rebuild. */
function proseChars(leafInput: string): number {
  let total = 0;
  for (const rawLine of leafInput.split('\n')) {
    const line = rawLine.replace(ROLE_TAG_RE, '').trim();
    if (line.length === 0 || line === '---' || line.startsWith('CONVERSATION: ')) continue;   // the CONVERSATION header is not prose
    if (/^\(called tool /.test(line) || /^\(tool result/.test(line)) continue;
    total += line.length;
  }
  return total;
}


/** Detect generateSummary's deterministic-truncation fallback (an echo of the raw input, the failure that created
 *  this contamination): SKIP the update and retry another night rather than replace an LLM summary with a raw dump. */
function looksLikeSummarizerFallback(input: string, output: string): boolean {
  if (output.includes(' tokens truncated ...]')) return true;
  const probe = input.trim().slice(0, 80);
  return probe.length >= 80 && output.trim().startsWith(probe);
}

/** Drop any output line that still matches the taxonomy (e.g. a marker quoted from a kept tool-result one-liner),
 *  so a rebuilt summary no longer matches and the mechanism cannot loop on it forever. */
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

/** Scan ALL summaries and return those still matching the taxonomy, depth-ASC then oldest-first (leaves first). */
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
      // Filler only if the descendants lack conversational prose, so the predicate is false on rebuilt content.
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


type RebuildOutcome =
  | 'rebuilt'       // regenerated through the current path + filter
  | 'placeholder'   // descendants were all noise/tool traffic; minimal placeholder written
  | 'deferred'      // condensed summary whose children are not clean yet; next night
  | 'skipped';      // cannot rebuild safely (e.g. source messages deleted, summary is the sole copy)

async function rebuildOneSummary(flag: FlaggedSummary, modelId: string): Promise<RebuildOutcome> {
  let input: string; let spanIds: string[];
  let depth: number;
  let targetTokens: number;

  if (flag.kind === 'leaf') {
    const msgs = getDescendantMessages(flag.id);
    if (msgs.length === 0) {
      // Source rows gone: this summary is the sole copy of the span, never overwrite it.
      logger.warn('Summary rebuild skipped: source messages gone, summary is the sole copy', {
        summaryId: flag.id, reason: flag.reason,
      }, flag.agentId);
      return 'skipped';
    }
    input = buildLeafInput(msgs);
    spanIds = msgs.map((m) => m.id);   // the check's key: this summary's own span
    if (input.trim().length === 0 || proseChars(input) < MIN_PROSE_CHARS) {
      // Everything in the span is plumbing: the live path's placeholder for all-noise chunks (the raw rows remain).
      writeRebuiltContent(flag, NO_CONVERSATION_PLACEHOLDER);
      return 'placeholder';
    }
    depth = 0;
    targetTokens = summaryTargetTokens(input, modelCharsPerToken(modelId));   // proportional to the input, like the live path
  } else {
    const children = getSummaryChildren(flag.id);
    if (children.length === 0) {
      logger.warn('Summary rebuild skipped: condensed summary has no children rows', {
        summaryId: flag.id,
      }, flag.agentId);
      return 'skipped';
    }
    // Children must be clean first, or condensing them would re-absorb the noise; depth ordering resolves it over nights.
    if (children.some(c => isContaminatedSummaryContent(c.content))) {
      return 'deferred';
    }
    const allPlaceholders = children.every(c => c.content === NO_CONVERSATION_PLACEHOLDER);
    if (allPlaceholders) {
      writeRebuiltContent(flag, NO_CONVERSATION_PLACEHOLDER);
      return 'placeholder';
    }
    input = condensedSummaryInput(children);
    spanIds = children.map((c) => `summary:${c.id}`);
    depth = flag.depth;
    targetTokens = mergeTargetTokens(input, children.length, modelCharsPerToken(modelId));   // a merge, as the live condenser asks
  }

  // Paced by real signals, as the older mixed notes are; the note stays flagged for a later night.
  const wait = waitReason(flag.agentId, modelId, estimateTokens(input) + targetTokens, targetTokens);
  if (wait) { logger.warn('Summary rebuild waits', { summaryId: flag.id, reason: wait }, flag.agentId); return 'deferred'; }
  const result = await generateSummary({
    content: input,
    depth,
    targetTokens,
    agentId: flag.agentId,
    modelId, spanIds,
  });

  // A summariser refusal is a skip: the row stays flagged and the next night tries again. The prefix check below
  // covers older rows that were truncated copies of the raw input.
  if (!result.ok) {
    logger.warn('Summary rebuild REFUSED by the summarizer; leaving summary for a later night', {
      summaryId: flag.id, reason: result.reason,
    }, flag.agentId);
    return 'skipped';
  }
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
  const finalText = scrubbed.text.length > 0 ? scrubbed.text : NO_CONVERSATION_PLACEHOLDER;

  writeRebuiltContent(flag, finalText);
  return finalText === NO_CONVERSATION_PLACEHOLDER ? 'placeholder' : 'rebuilt';
}

/** Persist the regenerated content. The AFTER UPDATE OF content triggers (migration 083) keep summaries_fts in
 *  sync; `refreshEmbedding` re-embeds best-effort (the scheduled backfill covers a summary left without a row). */
function writeRebuiltContent(flag: FlaggedSummary, text: string): void {
  updateSummaryContent(flag.id, text, estimateTokens(text));
  refreshEmbedding('summary', flag.id, flag.agentId, text);
}


export interface SummaryRebuildStats {
  flaggedBefore: number;
  rebuilt: number;
  placeholders: number;
  deferred: number;
  skipped: number;
  remainingAfter: number;
  /** Total summaries in the store this run looked at. */
  stockScanned: number;
  /** Consecutive runs, INCLUDING this one, that scanned a non-empty stock and found nothing contaminated. */
  consecutiveCleanRuns: number;
  /** The second selection: recent mixed notes rebuilt one conversation each. */
  legacy?: LegacyRebuildStats;
}



/**
 * Run one bounded rebuild batch: nightly from the vault maintenance window (`vault/maintenance.ts`), and callable
 * directly on a dev box. `opts.modelId` overrides the writer model; then the recent mixed notes are rebuilt.
 */
export async function runSummaryRebuildBatch(opts?: { modelId?: string }): Promise<SummaryRebuildStats> {
  const empty: SummaryRebuildStats = { flaggedBefore: 0, rebuilt: 0, placeholders: 0, deferred: 0, skipped: 0, remainingAfter: 0, stockScanned: 0, consecutiveCleanRuns: 0 };

  if (rebuildGuard.running) {
    logger.warn('Summary rebuild already running, skipping this invocation');
    return empty;
  }
  rebuildGuard.running = true;
  try {
    const stats = await runContaminationPass(empty, opts);
    try {   // the second selection runs whatever the first found: its notes are another question
      stats.legacy = await rebuildLegacyMixedNotes();
    } catch (err) {
      logger.warn('Older mixed notes: rebuild pass failed; the next run resumes it', { error: err instanceof Error ? err.message : String(err) });
    }
    return stats;
  } finally {
    rebuildGuard.running = false;
  }
}

async function runContaminationPass(empty: SummaryRebuildStats, opts?: { modelId?: string }): Promise<SummaryRebuildStats> {
    const flagged = findContaminatedSummaries();
    const stockScanned = countSummaryStock();
    if (flagged.length === 0) {
      const streak = recordCleanStock(0, stockScanned);
      logger.info(
        `SUMMARY_REBUILD_CLEAN_STOCK stockScanned=${stockScanned} flagged=0 ` +
        `consecutiveCleanRuns=${streak}`,
        { stockScanned, flagged: 0, consecutiveCleanRuns: streak },
      );
      return { ...empty, stockScanned, consecutiveCleanRuns: streak };
    }
    // Anything flagged resets the streak: the write boundary is not yet provably holding.
    recordCleanStock(flagged.length, stockScanned);

    // Each flag's writer is resolved for its own agent: its own model, else the small writer, never one that waits.
    const stats: SummaryRebuildStats = { ...empty, flaggedBefore: flagged.length, stockScanned };
    for (const flag of flagged) {
      const modelId = opts?.modelId ?? pickWriter(flag.agentId);
      if (!modelId) { stats.skipped++; continue; }   // no writer answering for this agent: a later night
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
    logger.info('Summary rebuild nightly batch done', { ...stats });
    if (stats.remainingAfter === 0) {
      // The streak starts at the first run that scanned a real stock and found it clean; this run repaired its way there.
      stats.consecutiveCleanRuns = recordCleanStock(0, stats.stockScanned);
      logger.info(
        `SUMMARY_REBUILD_CLEAN_STOCK stockScanned=${stats.stockScanned} flagged=0 ` +
        `consecutiveCleanRuns=${stats.consecutiveCleanRuns} (repaired this run)`,
        { ...stats },
      );
    }
    return stats;
}
