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
//            rule's answer stands. Only then does the turn wait for the call, and a call that fails or
//            runs out of its measured time is the rule's answer (`decide()` logs why).
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
import { decide, type Answer, type Question } from '../decide.js';
import { modeFor } from '../decision-policy.js';
import { inWeakestBand, recordShadow, scoreQuestion, verdictOf } from '../decision-shadow.js';
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
  /** A question here is in `model`: the floors read the answer, so the turn waits for it. */
  readonly acts: boolean;
  /** undefined while in flight; null when the call gave no answer. */
  answers: Record<string, Answer> | null | undefined;
  settled: Promise<void>;
  toldFallback: boolean;
}
/** Per agent, the one reply its floors are reading now; the next reply replaces it (so it never grows). */
const asked = new Map<string, Asked>();

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
      const modes = NAMES.map((q) => [q, modeFor(PURPOSE, q)] as const).filter(([, m]) => m !== 'rule');
      if (modes.length === 0) return;
      entry = ask(state, ctx, reply, modes.map(([q]) => q), modes.some(([, m]) => m === 'model'));
      asked.set(agentId, entry);
    }
    if (entry.acts) await entry.settled;
  } catch (err) {
    logger.warn('reply claims were not asked; the rules decide', { error: err instanceof Error ? err.message : String(err) }, ctx.agentId);
  }
}

function ask(state: AgentTurnState, ctx: PostCallClassifyContext, reply: string, questions: ReplyClaimQuestion[], acts: boolean): Asked {
  const { agentId, messageId } = ctx;
  const turnId = replyClaimsTurnId(messageId);
  const counterpartyName = ctx.counterparty?.name ?? null;
  const ruleSaid = Object.fromEntries(questions.map((q) => [q, RULES[q](reply, counterpartyName)]));
  const entry: Asked = { key: messageId, acts, answers: undefined, settled: Promise.resolve(), toldFallback: false };
  const stateForModel = {
    reply,
    last_user_message: ctx.lastUserMessageContent ?? null,
    tool_calls_this_turn: state.toolResults.map((r) => r.name).filter(Boolean),   // C5: the whole turn's, not this pass's
  };
  // Nobody waits on a shadow call, so it waits for the agents' own local work and holds no slot of this
  // agent's turn (no `agentId`: a call that outlives its turn is not that turn's work).
  const opts = acts ? { purpose: PURPOSE, agentId, turnId } : { purpose: PURPOSE, turnId, background: true };
  entry.settled = decide(stateForModel, Object.fromEntries(questions.map((q) => [q, REPLY_CLAIM_QUESTIONS[q]])), opts)
    .then((answers) => {
      entry.answers = answers;
      if (answers) for (const q of questions) recordShadow({ purpose: PURPOSE, question: q, agentId, turnId, ruleSaid: ruleSaid[q], modelSaid: answers[q] ?? null });
    })
    .catch((err) => {
      entry.answers = null;
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
    if (modeFor(PURPOSE, question) !== 'model') return ruleSaid;
    const entry = asked.get(at.agentId);
    const a = entry && entry.key === at.messageId ? entry.answers?.[question] : undefined;
    const score = a?.type === 'noul' ? scoreQuestion(PURPOSE, question) : null;
    if (!a || a.type !== 'noul' || !score) {
      if (entry && !entry.toldFallback) {
        entry.toldFallback = true;
        logger.info('reply claims: no model answer for this reply; the rule decides', { question }, at.agentId);
      }
      return ruleSaid;
    }
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
/** Test-only: forget every reply's call. */
export function __forgetReplyClaimsForTests(): void { asked.clear(); }
