// ════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 4 T20 — A SUMMARY IS NOT A SECOND LEDGER.
//
// The summarizer is INSTRUCTED to record obligations, and its instruction states the law that
// nothing implemented (`memory/summarize.ts`):
//
//     "cite its work id as written … the id is the record, the summary is the context around it"
//
// `839eedc` deleted the fenced OPEN-LOOPS block and its prose parser — a summariser writing
// the obligation ledger — and ADDED that citation instruction in the same commit. Nothing was
// ever built to READ the citation. So a line the model wrote in good faith on 2026-08-06
// ("two quotes still parked, waiting on Bob's address") was still being served, present tense,
// on 2026-08-10, from two stored summaries, while the OPEN WORK block in the same assembled
// prompt correctly carried none of them. This module is the missing reader.
//
// ── THE PRINCIPLE, THIRD AND FINAL SURFACE ──
// SWEEP CORE-2 item 4: recall resolves hits against the authoritative record — NO PARALLEL
// MEMORY OF ANSWERS. UX-REPAIR T17 pointed it at the vault: no parallel memory of OBLIGATIONS.
// This points it at summaries. The spine is the only truth about what is owed, and there is
// exactly ONE resolver — `work/obligation-memory.ts` — which this file calls rather than
// reimplements. A second copy of "what does this token resolve to" is the thing all three
// tasks exist to prevent.
//
// ── WHY AT WRITE, AND WHY NOTHING IS EVER REWRITTEN AT RENDER ──
// Summaries ride `MessageSlot.Summaries = 300`, INSIDE `volatileFrom` — the cacheable prompt
// prefix. T17 could resolve at READ because the recall lane is TAIL (its own commit body: "no
// prompt-prefix edit — this task touches no cached surface"); slot 300 is the other side of
// that line. So the resolution happens where the summariser's own separate model call already
// is: at WRITE, once, into the stored text. Rendering reads the row exactly as stored, so a
// turn's prefix bytes are what they were on the turn before. The one static sentence that says
// which block is current lives in the lane header and is a registered re-blessing.
//
// ── IT ANNOTATES; IT NEVER REWRITES ──
// The agent's own sentence is left intact and the engine's finding is APPENDED, in brackets,
// on the same line. Same shape as the vault's `markObsolete` (a flag beside the words, never
// an edit of them) and the same reason: a memory the platform silently rewrote is a memory
// nobody can audit.
//
// ── AND IT NEVER GUESSES ──
// A line is only touched when it carries one of the two literal join tokens the model itself
// wrote — `cmt:<hex>` or `promise-<runid>`. A line that merely SOUNDS like an obligation is
// left exactly as written. That is the same refusal `839eedc` bought with 623 deleted lines,
// and it is why the one-time hygiene pass over stored rows is deterministic rather than a
// second prose parser wearing a different hat.
//
// ════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 7 T28 — BOB'S LAST SURFACE.
//
// The paragraph above is why T20 shipped as an id-ONLY pass, and it counted the price of that
// choice honestly: 17 obligation lines in stored summaries carried no id and were left. Round
// 7 measured what the price bought. On 2026-08-11, FIVE stored summaries for BehaviorBot still
// said "the fence and roof quotes are still parked, waiting on Bob's address" — ten separate
// lines, not one of them citing an id — while every one of that agent's 131 commitment rows
// was terminal (87 naming Bob, all `abandoned`, newest closed 2026-08-06). The week-overview
// answer served them to the owner as live work. That is the fourth recurrence of the same
// class across rounds 3, 4 and 7, and the header sentence T20 added to the lane
// ("obligation lines here are HISTORICAL") did not stop it.
//
// So the ban narrows to admit exactly one shape, and the narrowing lives in
// `work/obligation-memory.ts` §4 — beside the id resolver, not in a second file — because
// "what does this line resolve to" must keep having exactly one owner. What it may say is
// bounded three ways: the line must already read as an obligation IN PROSE, it must name a
// counterparty AND a deliverable that the agent's OWN spine rows carry, and one still-open row
// anywhere in the match set leaves the line untouched. What it may NOT do is unchanged: it
// never rewrites the agent's words, never runs at render time, and never touches the vault.
// ════════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import {
  obligationTags, obligationVerdict,
  idlessObligationVerdict, commitmentVocabularyFor, type RowVocabulary,
} from '../work/obligation-memory.js';
import { updateSummaryContent } from './dag.js';
import { estimateTokens } from './budget.js';

const logger = createLogger('summary-obligations');

/** The opening of the engine's appended finding. One literal, so the writer, the idempotence
 *  check and the tests all read the same token and cannot drift. */
export const SUMMARY_OBLIGATION_MARK = '[work state as of ';

/** T28's second literal: an obligation-shaped line that names somebody this agent has
 *  commitments with, but no deliverable any of them records. It says the one true thing
 *  available — that nothing LIVE matches — and never that the obligation is dead. */
export const SUMMARY_NO_MATCH_MARK = '[historical note — no live commitment matches]';

/** `YYYY-MM-DD`, the granularity every other dated marker in this tree uses. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The finding for ONE line, or null when the line carries no join token at all. */
function findingFor(line: string): string | null {
  if (obligationTags(line).length === 0) return null;
  const verdict = obligationVerdict(line);
  switch (verdict.kind) {
    case 'closed':
      return `${SUMMARY_OBLIGATION_MARK}${today()}: ${verdict.states.join('/')}]`;
    case 'live':
      return `${SUMMARY_OBLIGATION_MARK}${today()}: open]`;
    case 'unresolvable':
      // NOT dead — unknown. The same distinction the recall lane draws, for the same reason:
      // declaring a record dead because we could not find it is how a memory becomes a lie in
      // the other direction.
      return `${SUMMARY_OBLIGATION_MARK}${today()}: no matching record on the work spine — `
        + 'verify before repeating as owed]';
    case 'not-an-obligation':
    default:
      return null;
  }
}

/**
 * T28: the finding for one line the model gave NO id, or null to leave it alone.
 *
 * The annotation NAMES the row it matched. An id-cited line needs no such thing — the id is
 * already in the sentence — but a name match is an inference, and an inference the reader
 * cannot check is the same lie in a new place. It also disambiguates the one multi-topic line
 * the incident produced, where the obligation clause is the last of three.
 */
function idlessFindingFor(line: string, agentId: string, vocab: RowVocabulary[]): string | null {
  const verdict = idlessObligationVerdict(line, agentId, vocab);
  switch (verdict.kind) {
    case 'closed':
      return `${SUMMARY_OBLIGATION_MARK}${today()}: ${verdict.states.join('/')} — matched by name to `
        + `${verdict.workIds.length} commitment row(s), newest ${verdict.newest}]`;
    case 'unmatched':
      return SUMMARY_NO_MATCH_MARK;
    case 'live':          // still owed: the line is TRUE and stays exactly as written
    case 'not-an-obligation':
    default:
      return null;
  }
}

/**
 * Resolve every id-cited obligation line in a summary against the spine.
 *
 * Line-oriented on purpose: the summariser writes one item per line, the annotation belongs to
 * the item, and a whole-text transform could not say WHICH obligation it had resolved.
 * Idempotent by the mark, so the write path and the one-time hygiene pass can both run over
 * the same text without stacking.
 */
export function annotateSummaryObligations(text: string, agentId?: string): string {
  if (!text) return text;
  // T28's leg is agent-scoped by construction — a spine belongs to one agent — so a caller
  // that cannot name the agent gets exactly T20's behaviour, byte for byte.
  const vocab = agentId ? commitmentVocabularyFor(agentId) : [];
  if (vocab.length === 0 && !text.includes('cmt:') && !text.includes('promise-')) return text;
  let changed = false;
  const out = text.split('\n').map((line) => {
    if (line.includes(SUMMARY_OBLIGATION_MARK) || line.includes(SUMMARY_NO_MATCH_MARK)) return line;
    const finding = findingFor(line)
      ?? (agentId && vocab.length > 0 ? idlessFindingFor(line, agentId, vocab) : null);
    if (!finding) return line;
    changed = true;
    return `${line.trimEnd()} ${finding}`;
  });
  return changed ? out.join('\n') : text;
}

/** One line a sweep would touch, so the pass can be READ before it is applied. */
export interface SummaryObligationCandidate {
  summaryId: string;
  agentId: string;
  line: string;
  finding: string;
}

export interface SummaryObligationSweep {
  scanned: number;
  affected: number;
  ids: string[];
  candidates: SummaryObligationCandidate[];
}

/**
 * The one-time hygiene pass over ALREADY-STORED summaries.
 *
 * MEASURED BEFORE IT IS APPLIED — `dryRun` returns exactly what a run would touch and writes
 * nothing, because a bulk rewrite of the agent's memory is not something to discover the size
 * of afterwards. It is deterministic: id-cited lines only, no prose guessing, so a summary
 * carrying an obligation the model never gave an id is left exactly as written. On the worn-in
 * dev body that is every one of them — measured 2026-08-10: 158 summaries, ZERO citing a
 * `cmt:` or `promise-` token — which is the honest reason the pass is a no-op there and the
 * reason the summarizer contract, not this sweep, is the fix for the origin.
 *
 * Writes through `dag.ts:updateSummaryContent`, the ONE sanctioned in-place mutator of
 * `summaries.content` (`memory/summary-rebuild.ts`'s nightly rewrite is its other caller).
 */
export function sweepStoredSummaryObligations(
  opts: { dryRun: boolean; agentId?: string },
): SummaryObligationSweep {
  const db = getDb();
  const rows = (opts.agentId
    ? db.prepare('SELECT id, agent_id, content FROM summaries WHERE agent_id = ?').all(opts.agentId)
    : db.prepare('SELECT id, agent_id, content FROM summaries').all()
  ) as Array<{ id: string; agent_id: string; content: string }>;

  // One spine read per agent, not per line — a body with 162 summaries is a routine size here.
  const vocabByAgent = new Map<string, RowVocabulary[]>();
  const ids: string[] = [];
  const candidates: SummaryObligationCandidate[] = [];
  for (const r of rows) {
    if (!vocabByAgent.has(r.agent_id)) vocabByAgent.set(r.agent_id, commitmentVocabularyFor(r.agent_id));
    const vocab = vocabByAgent.get(r.agent_id) ?? [];
    // The per-line record the measurement obligation needs. Same two deciders the writer
    // uses, in the same order, so what is reported is what would be written.
    for (const line of (r.content ?? '').split('\n')) {
      if (line.includes(SUMMARY_OBLIGATION_MARK) || line.includes(SUMMARY_NO_MATCH_MARK)) continue;
      const finding = findingFor(line)
        ?? (vocab.length > 0 ? idlessFindingFor(line, r.agent_id, vocab) : null);
      if (finding) candidates.push({ summaryId: r.id, agentId: r.agent_id, line: line.trim(), finding });
    }
    const next = annotateSummaryObligations(r.content ?? '', r.agent_id);
    if (next === r.content) continue;
    ids.push(r.id);
    if (!opts.dryRun) updateSummaryContent(r.id, next, estimateTokens(next));
  }
  logger.info('summary obligation hygiene pass', {
    scanned: rows.length, affected: ids.length, lines: candidates.length, dryRun: opts.dryRun,
  });
  return { scanned: rows.length, affected: ids.length, ids, candidates };
}
