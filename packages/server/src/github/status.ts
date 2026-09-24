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

export function githubStatus(): GithubStatus {
  const account = getGithubAccount();
  const connected = getGithubToken() !== null;
  const flow = deviceFlowInProgress();
  return {
    connected,
    login: account?.login ?? null,
    scope: account?.scope ?? null,
    connectedAt: account?.connectedAt ?? null,
    lastOkAt: account?.lastOkAt ?? null,
    lastError: account?.lastError ?? null,
    reauthRequired: account !== null && !connected,
    clientIdConfigured: githubClientId() !== null,
    loginInProgress: flow !== null,
    userCode: flow?.userCode ?? null,
    verificationUri: flow?.verificationUri ?? null,
  };
}
