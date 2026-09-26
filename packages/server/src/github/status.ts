// ════════════════════════════════════════════════════════════════════════════════════════
// WHAT THE GITHUB CARD IS TOLD (DOJO-REPORT T4).
//
// ── WHY THIS IS ITS OWN MODULE ──
// Two reasons, and the first is a graph fact rather than tidiness. The status is the UNION of
// two things that live in two places: the STORED row (`account.ts`) and the LIVE flow
// (`device-flow.ts`). Putting it in either one makes the pair a CYCLE — account would import
// the flow to know whether a sign-in is open, and the flow already imports account to save
// what it won. A third module that reads both leaves the dependency running one way.
// (The second reason is the size ratchet: `device-flow.ts` was measured at 270 lines with this
// function inside it, over `check-growth.mjs`'s 240 line. The plan's instruction for that case
// is explicit — SPLIT IT — and this is the seam that was already there.)
//
// ── THE DOCTRINE THIS MODULE SERVES ──
// `memory/integration-status-lane.ts`: *"the agent must never have to trust a notebook entry
// saying a connection is broken. The PLATFORM'S LIVE TRUTH sits in front of it every turn and
// OUTRANKS memory."* So every field below is MEASURED or STORED, and not one is inferred:
//
//   connected       — a token is here AND it opens. Not "a row exists", not "we connected once".
//   reauthRequired  — the honest name for the half-state a rotated master key produces: the row
//                     says this box connected, and the sealed value will not open. Without this
//                     field the card would have to choose between claiming a broken connection
//                     works and forgetting the owner ever connected.
//                     ── WIDENED IN T5, and the reason is this module's own doctrine. A token
//                     GitHub has REVOKED still opens perfectly here: nothing local broke. The
//                     T4 derivation therefore read a 401 box as fully connected while every
//                     post was being refused — a stored claim outranking the live outcome,
//                     which is the exact inversion of the rule above. So the LAST LIVE OUTCOME
//                     counts too, when that outcome was GitHub refusing the credential.
//   lastOkAt/lastError — the LAST LIVE OUTCOME of a real GitHub call, written by
//                     `noteGithubOk`/`noteGithubFailure` and by nothing else. There is no timer
//                     here, no staleness heuristic, and no invented freshness.
//   loginInProgress — read from the live flow, so the card cannot show a code that has already
//                     expired or been cancelled.
//
// NO TOKEN FIELD, AND THERE NEVER MAY BE ONE. This shape is what `GET /api/github/status`
// returns verbatim, so a token field here would be a token in an HTTP response body. The suite
// drives the real router and reads the bytes of every answer rather than trusting this comment.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getGithubAccount, getGithubToken, githubClientId } from './account.js';
import { deviceFlowInProgress } from './device-flow.js';

export interface GithubStatus {
  connected: boolean; login: string | null; scope: string | null;
  connectedAt: string | null; lastOkAt: string | null; lastError: string | null;
  reauthRequired: boolean; clientIdConfigured: boolean;
  loginInProgress: boolean; userCode: string | null; verificationUri: string | null;
}

/**
 * Every way the platform can say "GitHub would not accept this credential".
 *
 * ── WHY A READER OF FREE TEXT AT ALL ──
 * `last_error` is one column holding the platform's own sentence about the last live outcome,
 * and `noteGithubFailure` takes a message rather than a kind (T4's signature, and T7 writes
 * through it). Splitting the column into a kind would be a schema change in the task that only
 * READS it, so the reading is done here, in one exported place, with a fixture table in front
 * of it rather than a claim that the shapes are known.
 *
 * ── WHAT THE COLUMN ACTUALLY CONTAINED, AND FOR HOW LONG (C1) ──
 * SIX of the nine patterns below were UNREACHABLE CODE until `github/refusal.ts` was taught to
 * put GitHub's own `message` in the line it records. `bad credentials`, `unauthorized`,
 * `requires authentication`, `required scopes`, `insufficient scope` and
 * `not accessible by personal access token` are strings GITHUB writes in a response body, and no
 * writer of this column had ever passed one through: T4's message was the platform's own
 * sentence, and T7's was a fixed verb plus a status code. So this predicate was built for input
 * the ledger was never fed.
 *
 * The cost was not cosmetic and it was not the 401 case. `(HTTP 401)` matches the status-word
 * anchor below, so the one shape everyone tested worked. A REVOKED SCOPE does not answer 401:
 * GitHub answers 403 with `Resource not accessible by personal access token`, the recorded line
 * was `GitHub refused to file the issue (HTTP 403).`, nothing matched, and the card told an owner
 * whose token could no longer file anything that the connection was working — a stored claim
 * outranking the live outcome, the exact inversion this module exists to refuse.
 *
 * Provider text now reaches this reader, so all nine patterns are live. The narrowness below
 * therefore stopped being decoration and started being the thing doing the work — which is why
 * the fixture table was re-driven against the real bodies GitHub sends, both directions, rather
 * than extended only on the side that now passes.
 *
 * ── THE DIRECTION IT IS WRONG IN IS CHOSEN ──
 * A false NO costs the reconnect prompt and nothing else: `lastError` is still rendered
 * verbatim in a warning, so the owner still sees the failure and can still press Disconnect. A
 * false YES tells someone their working connection is broken and invites them to tear it down.
 * So the list below is deliberately NARROW — credentials and scope, never "an error happened".
 * A 403 is on it only in the two spellings that are unambiguously about permission; a 403 rate
 * limit is not a broken connection and must not read as one.
 *
 * ── FIX ROUND 1 (review F1): A NUMERAL 401 IN PROSE IS NOT A STATUS CODE ──
 * This list began with `\b401\b`, which was already one step better than `includes('401')` —
 * it refuses `401k-planner`, a repository name. It was not enough, and the gap ran the wrong
 * way. `\b401\b` matches the number in ANY context, so *"Could not comment on issue 401"* and
 * *"Failed to update issue #401 on d-cornerpin/dojo"* both read as a revoked credential and
 * would tell an owner whose connection works perfectly that it stopped working — the exact
 * false YES the paragraph above says this predicate chose against.
 *
 * ISSUE NUMBERS ARE T7's WHOLE DOMAIN. T7 builds `findIssueBySignature`, `createIssue` and
 * `commentOnIssue`, and naming the issue it could not comment on is the obvious sentence to
 * write into this very column.
 *
 * So the bare number counts only where it is PRESENTED AS A STATUS CODE — sentence-initial,
 * bracketed, or introduced by a status word. That is an anchor on the shapes an auth failure
 * actually takes, rather than an attempt to enumerate the prose it must not match, which is
 * unbounded. (The reviewer's suggested pattern was measured before being adopted and still
 * fired on their own first example; this one is driven against both directions in the fixture
 * table, 34 rows.)
 *
 * T7 HAND-OFF: do not put an issue number in a `noteGithubFailure` message. The anchors below
 * make the common spellings safe, but the honest contract is that this column carries the
 * platform's verdict about the CALL, not identifiers from its payload. (C1 widened that column
 * to carry GITHUB's sentence about the call as well, which is the same contract one party over:
 * provider prose, never a payload identifier. GitHub's rate-limit body names a numeric user id,
 * and `API rate limit exceeded for user ID 401.` is a row in the fixture table for that reason.)
 */
const AUTH_REFUSAL = [
  /^\s*401\b/,
  /[([]\s*401\b/,
  /\b(?:http|https|status|code|error|answered|returned|responded|replied|received|rejected|refused|failed)\s+(?:code\s+)?401\b/i,
  /bad credentials/i,
  /unauthoriz(?:ed|ation)/i,
  /requires authentication/i,
  /required scopes?\b/i,
  /insufficient scope/i,
  /not accessible by personal access token/i,
];

export function looksLikeAuthFailure(message: string | null | undefined): boolean {
  if (!message) return false;
  return AUTH_REFUSAL.some(r => r.test(message));
}

export function githubStatus(): GithubStatus {
  const account = getGithubAccount();
  const connected = getGithubToken() !== null;
  const flow = deviceFlowInProgress();
  const lastError = account?.lastError ?? null;
  return {
    connected,
    login: account?.login ?? null,
    scope: account?.scope ?? null,
    connectedAt: account?.connectedAt ?? null,
    lastOkAt: account?.lastOkAt ?? null,
    lastError,
    // Two half-states, one honest answer: the seal will not open (nothing local works), or
    // GitHub refused the credential on the last real call (nothing remote works). Either way
    // the only cure is the same human act, so the card asks for it in one word.
    reauthRequired: account !== null && (!connected || looksLikeAuthFailure(lastError)),
    clientIdConfigured: githubClientId() !== null,
    loginInProgress: flow !== null,
    userCode: flow?.userCode ?? null,
    verificationUri: flow?.verificationUri ?? null,
  };
}
