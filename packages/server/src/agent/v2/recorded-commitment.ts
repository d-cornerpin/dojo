// Uncommitted-promise floor, twin of claimed-delivery.ts: a recorded-commitment claim, no ledger row.

import { namesOpenWork } from './open-work-names.js';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('recorded-commitment');

// `ask` is excluded: `openAsk` writes one for the user's own inbound every turn, so counting it
// would leave a floor that can never fire; `occurrence` is the scheduler's, not the model's.
export const BOARD_KINDS: readonly string[] = ['commitment', 'task', 'project'];

/** A recording claim in the past tense. Both halves must be present, in ONE sentence. */
const RECORDED_VERB =
  /\b(recorded|logged|tracked|noted|saved|filed|captured|added|booked|put)\b/i;
const COMMITMENT_NOUN =
  /\b(commitment|commitments|promise|promised|obligation|follow[-\s]?up|to[-\s]?do)\b/i;
/** "on the books" / "on my list" carry the claim without either word above. */
const RECORDED_IDIOM = /\b(on the books|on my list|in the tracker|on the board)\b/i;

// Same-sentence negation or a future marker cancels the claim: the steer itself tells the model
// to say the promise is NOT tracked, and obeying that must never re-trigger the floor.
// `\w+n['’]t`, not `\bn['’]t`: there is no word boundary inside "haven't", so the bare form never matches.
const CANCELS_THE_CLAIM =
  /(?:\w+n['’]t|\bnot|\bnever|\bno)\s+(?:yet\s+)?(?:been\s+)?(?:\w+\s+){0,3}?(recorded|logged|tracked|noted|saved|filed|captured|added|booked)\b|\b(i['’]ll|i will|will be|going to|gonna|about to|let me|need to|should|can|could|shall)\s+(?:\w+\s+){0,2}?(record|log|track|note|save|file|capture|add|book|put)\b/i;

export type UncommittedPromiseStandDown =
  | 'no-claim-in-text'    // the narrowing found no past-tense recorded-commitment claim
  | 'work-open-ran'       // a `work_open` succeeded this turn; the kind is not our business
  | 'ledger-holds-work'   // ← THE AUTHORITY: the spine has a row from this turn
  | 'claim-names-open-work'; // a STATUS of work already open on the board, named by its own title

export interface UncommittedPromiseFires {
  fires: true;
  claim: string;
  wentToMemory: boolean;
}

export interface UncommittedPromiseStandsDown {
  fires: false;
  reason: UncommittedPromiseStandDown;
}

export type UncommittedPromiseDecision = UncommittedPromiseFires | UncommittedPromiseStandsDown;

export interface RecordedCommitmentClaim {
  claimed: boolean;
  sentence: string;
}

// The narrowing only: does the reply claim a recording? The ledger, asked by the caller, decides.
export function detectRecordedCommitmentClaim(input: { responseText: string | null }): RecordedCommitmentClaim {
  const text = input.responseText?.replace(/\s+/g, ' ').trim();
  if (!text || text.length < 4) return { claimed: false, sentence: '' };
  // Sentence-scoped: a claim in one sentence counts, halves split across two sentences do not.
  const sentences = text.split(/(?<=[.!;:])\s+|\s+[—–]\s+/).map((s) => s.trim()).filter(Boolean);
  for (const s of sentences) {
    if (CANCELS_THE_CLAIM.test(s)) continue;
    const hasIdiom = RECORDED_IDIOM.test(s);
    const hasPair = RECORDED_VERB.test(s) && COMMITMENT_NOUN.test(s);
    if (hasIdiom || hasPair) return { claimed: true, sentence: s.slice(0, 200) };
  }
  return { claimed: false, sentence: '' };
}

export interface UncommittedPromiseInput {
  agentId: string;
  responseText: string | null;
  /** Cumulative tool activity this turn, never just the terminal iteration. */
  toolResultsThisTurn: ReadonlyArray<{ name?: string | null; isError?: boolean }>;
  /** Spine read, injected so the decision is testable without a database; ids opened this turn. */
  openedWorkThisTurn: () => readonly string[];
  /** Titles of board work still open from earlier turns. Absent: not consulted. */
  openBoardTitles?: () => readonly string[];
}

export function decideUncommittedPromise(input: UncommittedPromiseInput): UncommittedPromiseDecision {
  const claim = detectRecordedCommitmentClaim({ responseText: input.responseText });
  if (!claim.claimed) return { fires: false, reason: 'no-claim-in-text' };

  const succeeded = (name: string): boolean => input.toolResultsThisTurn.some((r) => r.name === name && r.isError !== true);

  // The generous arm, asked before the ledger: the model DID open work; the kind is its call.
  if (succeeded('work_open')) return { fires: false, reason: 'work-open-ran' };

  const rows = input.openedWorkThisTurn();
  if (rows.length > 0) return { fires: false, reason: 'ledger-holds-work' };
  if (namesOpenWork(claim.sentence, input.openBoardTitles?.() ?? [])) return { fires: false, reason: 'claim-names-open-work' };

  return { fires: true, claim: claim.sentence, wentToMemory: succeeded('vault_remember') };
}

export function openedBoardWorkSince(agentId: string, sinceMs: number): readonly string[] {
  try {
    const rows = getDb().prepare(
      `SELECT id FROM work
        WHERE agent_id = ? AND opened_at >= ?
          AND kind IN ('commitment','task','project')`,
    ).all(agentId, sinceMs) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  } catch (err) {
    // A ledger read that fails must SILENCE the floor, never accuse on a missing answer.
    logger.warn('uncommitted-promise: the spine read failed; standing down rather than accusing', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return ['read-failed'];
  }
}

export function uncommittedPromiseSteer(d: UncommittedPromiseFires): string {
  const where = d.wentToMemory
    ? 'You saved it to MEMORY instead, and memory carries no obligation: it does not age, it never enters your OPEN WORK block, and nothing will ever surface it as still owed. '
    : '';
  return (
    `[System: your reply tells the person you are talking to the commitment is recorded ("${d.claim}"), and the work ledger ` +
    `has nothing from this turn. ${where}` +
    `Call work_open(kind="commitment") now with what you promised, in your own words, in \`description\` — ` +
    `that is the only call that puts it on the ledger. If you would rather not track it, tell the person you are talking to ` +
    `plainly that it is NOT recorded. Do not leave a claim standing that the ledger does not back.]`
  );
}
