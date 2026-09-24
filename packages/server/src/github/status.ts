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
 * ── THE DIRECTION IT IS WRONG IN IS CHOSEN ──
 * A false NO costs the reconnect prompt and nothing else: `lastError` is still rendered
 * verbatim in a warning, so the owner still sees the failure and can still press Disconnect. A
 * false YES tells someone their working connection is broken and invites them to tear it down.
 * So the list below is deliberately NARROW — credentials and scope, never "an error happened".
 * A 403 is on it only in the two spellings that are unambiguously about permission; a 403 rate
 * limit is not a broken connection and must not read as one.
 *
 * `\b401\b`, not `includes('401')`: `401k-planner` is a repository name, and the naive spelling
 * turns one into a revoked token.
 */
const AUTH_REFUSAL = [
  /\b401\b/,
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
