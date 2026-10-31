// ════════════════════════════════════════════════════════════════════════════
// v3.5 C1 — THE NINE REPLY-CLAIM FLOORS ASK ONE DECISION CALL PER REPLY; THE LEDGER STILL DECIDES.
//
// Nine floors read a reply's own words against the ledger (spec A1–A9): the prose decline, the bare
// promise to start, the standing promise, the board-state claim, the claimed send, the denied send,
// the claimed report, the claimed save, the claimed commitment. Each one NARROWS with a rule (a regex)
// and the ledger — a delivery receipt, a work row, this turn's own tool record — is what fires.
// This module asks the decision model the spec's nine R3 questions about the reply in ONE `decide()`
// call, beside those rules, and B3's policy (`modeFor`) says per question what the answer may do:
//   rule   — no decision model, or the owner held the question to the rule: it is not asked at all.
//   shadow — the default. The call runs in the background (`background: true`) and the turn never waits
//            on it; the rule decides; both answers are logged in `decision_shadow` under the reply's id.
//   model  — B3 measured the model better. The floor's narrowing reads the model's verdict (the cut the
//            score measures, `verdictOf`) instead of its rule, except inside the measured band, where the
//            rule's answer stands. Only then does the turn wait for the call — for no longer than its
//            PATIENCE, the call's own measured timeout counted from when it asks, queued time included —
//            and a call that fails, runs out of patience, or is cut by the owner's Stop is the rule's answer.
// Each reply resolves its modes ONCE, when it asks, and the floors read those (fix round 1: no score read per floor).
// Every floor keeps its ledger conjuncts. The one floor with NO ledger behind it — the prose decline,
// which swallows a reply — lets the model take a rule hit away and never add one (REVIEW FOCUS 5).
//
// NO TRUTH IS RECORDED HERE, stated rather than invented. Each question asks what the reply CLAIMS; the
// ledger says what HAPPENED. Scoring a claim against what happened marks a detector WRONG exactly when
// it catches a false claim ("saved" when nothing saved), which is the case these floors exist for, and
// B3 would promote a model on that signal by itself. Until a source that knows what a reply claimed
// joins `decision_shadow` on `replyClaimsTurnId` (`recordTruth`), every question stays in shadow.
// ════════════════════════════════════════════════════════════════════════════

import { isBareNoReplySentinel } from '@dojo/shared';
import { createLogger } from '../../logger.js';
import { decide, measuredDecideTimeoutMs, type Answer, type DecideOpts, type FailureClass, type Question } from '../decide.js';
import { modeFor, type Mode } from '../decision-policy.js';
import { inWeakestBand, recordShadow, scoreQuestion, verdictOf, type QuestionScore } from '../decision-shadow.js';
import { isForwardPromiseReply, isStandingPromiseReply, isStandingStateClaimReply } from './ack-copy.js';
import { detectDeliveryDenial, detectUngroundedDeliveryClaim } from './classifiers/grounding.js';
import { claimsDelivery } from './refused-delivery.js';
import { detectRecordedCommitmentClaim, type RecordedCommitmentClaim } from './recorded-commitment.js';
import type { AgentTurnState } from './state.js';
import type { PostCallClassifyContext } from './steps/post-call-classify/index.js';

const logger = createLogger('reply-claims');

export const REPLY_CLAIM_PURPOSE = 'reply_claims';
const PURPOSE = REPLY_CLAIM_PURPOSE;

const NAMES = [
  'declines_to_reply', 'only_promises_to_start', 'standing_promise', 'asserts_board_state',
  'claims_sent_to_third_party', 'denies_having_sent', 'claims_report_delivered', 'claims_saved',
  'claims_commitment_recorded',
] as const;
export type ReplyClaimQuestion = typeof NAMES[number];

/** The spec's R3 questions, verbatim: the decision model's whole prompt for this purpose. */
export const REPLY_CLAIM_QUESTIONS: Record<ReplyClaimQuestion, Question> = {
  declines_to_reply: { type: 'noul', instructions: 'Does `reply` state that no reply will be sent to anyone?',
    criteria: { true: 'An explicit decision to not respond', false: 'Any answer, even one mentioning "no reply" in passing' } },
  only_promises_to_start: { type: 'noul', instructions: 'Does `reply` END by promising to begin work, with nothing delivered yet?',
    criteria: { true: 'Let me pull that up; give me a minute', false: 'Delivers content, asks a question, or says "let me know"' } },
  standing_promise: { type: 'noul', instructions: 'Does `reply` promise a behavior for every future occasion?' },
  asserts_board_state: { type: 'noul', instructions: 'Does `reply` assert the current status of scheduled or parked work?' },
  claims_sent_to_third_party: { type: 'noul', instructions: 'Does `reply` claim, in the past tense, that something was sent to someone other than the person being replied to?' },
  denies_having_sent: { type: 'noul', instructions: 'Does `reply` say something has not been sent yet?' },
  claims_report_delivered: { type: 'noul', instructions: 'Does `reply` claim a report was submitted or filed?' },
  claims_saved: { type: 'noul', instructions: 'Does `reply` claim something was saved or remembered?' },
  claims_commitment_recorded: { type: 'noul', instructions: 'Does `reply` claim a promise or task was recorded on a board or list?' },
};

/** A1's rule — a reply that OPENS with an unambiguous self-decline (`no-reply.ts` says why and when it applies). */
export const DECLINE_OPENER_RE = /^\s*[`*_>]*\s*(?:no\s+(?:reply|response)\s+(?:needed|necessary|required|warranted)\b|no\s+need\s+to\s+(?:reply|respond)\b|nothing\s+(?:to\s+)?(?:reply|respond|to\s+say)\b|i(?:'|’)?ll\s+hold\s+off\s+(?:on\s+)?repl|i\s+(?:won(?:'|’)?t|will\s+not|am\s+not\s+going\s+to)\s+(?:reply|respond)\b)/i;
/** A8's rule — the reply claims something was saved (`reply-floors.ts`, the RC-13.2 floor). */
export const SAVE_CLAIM_RE = /\b(saved|stored|remembered|noted it|added (it|that) to (memory|the vault)|put it in (memory|the vault))\b/i;

/** What each floor's rule says of the reply's words alone — the shadow log's `rule_said`. */
const RULES: Record<ReplyClaimQuestion, (reply: string, counterpartyName: string | null) => boolean> = {
  declines_to_reply: (r) => DECLINE_OPENER_RE.test(r),
  only_promises_to_start: (r) => isForwardPromiseReply(r),
  standing_promise: (r) => isStandingPromiseReply(r),
  asserts_board_state: (r) => isStandingStateClaimReply(r),
  // The prose half only: a send tool that ran is the ledger's half (`claimed-delivery.ts`), never the text's.
  claims_sent_to_third_party: (r, cp) => detectUngroundedDeliveryClaim({ responseText: r, toolCallsThisTurn: [], counterpartyName: cp }).ungrounded,
  denies_having_sent: (r) => detectDeliveryDenial({ responseText: r }).denied,
  claims_report_delivered: (r) => claimsDelivery(r),
  claims_saved: (r) => SAVE_CLAIM_RE.test(r),
  claims_commitment_recorded: (r) => detectRecordedCommitmentClaim({ responseText: r }).claimed,
};

/** The join key of one reply's shadow rows: the model reply they judged (its `messages` row id). */
export const replyClaimsTurnId = (messageId: string): string => `reply-claims:${messageId}`;

/** Which reply a floor is reading: the agent, and the id of the model reply this iteration produced. */
export interface ReplyAt { readonly agentId: string; readonly messageId?: string }

interface Asked {
  readonly key: string;
  /** Each question's mode, resolved once when the reply asked; a question absent here is `rule`. */
  readonly modes: Partial<Record<ReplyClaimQuestion, Mode>>;
  /** The score of each question in `model`, read with its mode (its band is what the floor reads against). */
  readonly scores: Partial<Record<ReplyClaimQuestion, QuestionScore>>;
  /** A question here is in `model`: the floors read the answer, so the turn waits for it. */
  readonly acts: boolean;
  /** undefined while in flight; null when the call gave no answer. */
  answers: Record<string, Answer> | null | undefined;
  settled: Promise<void>;
}
/** Per agent, the one reply its floors are reading now; the next reply replaces it (so it never grows). */
const asked = new Map<string, Asked>();

/**
 * THE OUTAGE, SAID ONCE (fix round 1): the first reply the decision model gives no answer for logs it, with why;
 * the first answer after that says it is back. Between the two, every reply's rows carry no model answer — the
 * logged provider failure those rows point to — and nothing more is logged per reply.
 */
let outage: FailureClass | 'threw' | null = null;
function noted(failure: FailureClass | 'threw' | null, agentId: string): void {
  if (failure !== null && outage === null) {
    logger.warn('the decision model gave no answer; the rules decide, and reply-claim rows carry no model answer until it answers again', { failure }, agentId);
  } else if (failure === null && outage !== null) {
    logger.info('the decision model answers again', { after: outage }, agentId);
  }
  outage = failure;
}

/**
 * Ask the nine questions about this reply, ONCE however many floors read it (memoised on the reply's id).
 * Resolves at once unless a question is in `model`; then it resolves when the answer is in, or the call
 * failed. Never throws into the turn.
 */
export async function askReplyClaims(state: AgentTurnState, ctx: PostCallClassifyContext, reply: string | null): Promise<void> {
  try {
    const { agentId, messageId, result } = ctx;
    if (!messageId || !reply || !reply.trim() || result.toolCalls.length > 0 || isBareNoReplySentinel(reply)) return;
    let entry = asked.get(agentId);
    if (entry?.key !== messageId) {
      const modes = Object.fromEntries(NAMES.map((q) => [q, modeFor(PURPOSE, q)] as const).filter(([, m]) => m !== 'rule')) as Asked['modes'];
      if (Object.keys(modes).length === 0) return;
      entry = ask(state, ctx, reply, modes);
      asked.set(agentId, entry);
    }
    if (entry.acts) await entry.settled;
  } catch (err) {
    logger.warn('reply claims were not asked; the rules decide', { error: err instanceof Error ? err.message : String(err) }, ctx.agentId);
  }
}

function ask(state: AgentTurnState, ctx: PostCallClassifyContext, reply: string, modes: Asked['modes']): Asked {
  const { agentId, messageId } = ctx;
  const turnId = replyClaimsTurnId(messageId);
  const questions = Object.keys(modes) as ReplyClaimQuestion[];
  const acting = questions.filter((q) => modes[q] === 'model');
  const scores = Object.fromEntries(acting.flatMap((q) => { const s = scoreQuestion(PURPOSE, q); return s ? [[q, s]] : []; })) as Asked['scores'];
  const counterpartyName = ctx.counterparty?.name ?? null;
  const ruleSaid = Object.fromEntries(questions.map((q) => [q, RULES[q](reply, counterpartyName)]));
  const acts = acting.length > 0;
  const entry: Asked = { key: messageId, modes, scores, acts, answers: undefined, settled: Promise.resolve() };
  const stateForModel = {
    reply,
    last_user_message: ctx.lastUserMessageContent ?? null,
    tool_calls_this_turn: state.toolResults.map((r) => r.name).filter(Boolean),   // C5: the whole turn's, not this pass's
  };
  // Nobody waits on a shadow call, so it waits for the agents' own local work and holds no slot of this
  // agent's turn (a background ask cannot name an agent: a call that outlives its turn is not that turn's work).
  // A call the turn waits on holds the agent's stop slot from the moment it queues. Either way its PATIENCE is the
  // call's own measured timeout (`measuredDecideTimeoutMs`): no longer than the call itself is allowed.
  const asking = Object.fromEntries(questions.map((q) => [q, REPLY_CLAIM_QUESTIONS[q]]));
  let failure: FailureClass | 'threw' | null = null;
  const onFailure = (f: FailureClass): void => { failure = f; };
  const patienceMs = measuredDecideTimeoutMs(stateForModel, questions.length);
  const opts: DecideOpts = acts
    ? { purpose: PURPOSE, agentId, turnId, onFailure, patienceMs }
    : { purpose: PURPOSE, turnId, onFailure, background: true, patienceMs, staleWhen: () => asked.get(agentId)?.key !== messageId };   // a newer reply replaced this one: nothing needs its answer
  const logRows = (answers: Record<string, Answer> | null): void => {
    for (const q of questions) recordShadow({ purpose: PURPOSE, question: q, agentId, turnId, ruleSaid: ruleSaid[q], modelSaid: answers?.[q] ?? null });
  };
  entry.settled = decide(stateForModel, asking, opts)
    .catch(() => { failure = 'threw'; return null; })
    .then((answers) => {
      entry.answers = answers;
      if (failure !== 'superseded') noted(answers ? null : failure ?? 'transport', agentId);   // dropped for a newer reply: no outage
      logRows(answers);   // a call that gave no answer still leaves its rows: the rule's answer, no model answer
    })
    .catch((err) => {
      logger.warn('reply claims could not be logged', { error: err instanceof Error ? err.message : String(err) }, agentId);
    });
  return entry;
}

/**
 * What a floor's narrowing reads for `question` on this reply: the rule's own answer, unless B3's policy
 * put the question in `model` AND the model answered this reply outside the measured band.
 */
export function replyClaim(at: ReplyAt, question: ReplyClaimQuestion, ruleSaid: boolean): boolean {
  try {
    const entry = asked.get(at.agentId);
    if (!entry || entry.key !== at.messageId || entry.modes[question] !== 'model') return ruleSaid;
    const a = entry.answers?.[question];
    const score = entry.scores[question];
    if (!a || a.type !== 'noul' || !score) return ruleSaid;   // no answer: the outage is logged once, above
    return inWeakestBand(score, a.noul) ? ruleSaid : verdictOf(a).said === 'true';
  } catch {
    return ruleSaid;
  }
}

/** `replyClaim` for a rule that FINDS something (the sentence to quote): what it found, the reply itself when
 *  only the model saw the claim, or null. */
export function replyClaimOf<T>(at: ReplyAt, question: ReplyClaimQuestion, found: T | null, whole: T): T | null {
  return replyClaim(at, question, found !== null) ? (found ?? whole) : null;
}

/** A9's narrowing for `decideUncommittedPromise`: the rule's claim, the reply itself (what the steer quotes and the
 *  open titles are matched against) when only the model saw one, or none. */
export const commitmentClaimFor = (at: ReplyAt, reply: string) => (rule: RecordedCommitmentClaim): RecordedCommitmentClaim =>
  replyClaimOf(at, 'claims_commitment_recorded', rule.claimed ? rule : null, { claimed: true, sentence: reply.replace(/\s+/g, ' ').trim().slice(0, 200) })
  ?? { claimed: false, sentence: '' };

/** Test-only: the reply's call has settled (answered, failed, or logged). */
export const __replyClaimsSettledForTests = (agentId: string): Promise<void> => asked.get(agentId)?.settled ?? Promise.resolve();
/** Test-only: forget every reply's call, and any outage. */
export function __forgetReplyClaimsForTests(): void { asked.clear(); outage = null; }
