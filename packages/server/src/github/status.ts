// The card's status joins the stored row (`account.ts`) and the live flow (`device-flow.ts`) in a third module,
// so `account.ts` need not import the flow (a cycle). Every field is measured or stored. Never add a token
// field: `GET /api/github/status` returns this shape verbatim.

import { getGithubAccount, getGithubToken, githubClientId } from './account.js';
import { deviceFlowInProgress } from './device-flow.js';

export interface GithubStatus {
  connected: boolean; login: string | null; scope: string | null;
  connectedAt: string | null; lastOkAt: string | null; lastError: string | null;
  reauthRequired: boolean; clientIdConfigured: boolean;
  loginInProgress: boolean; userCode: string | null; verificationUri: string | null;
}

/** True when the last recorded error says GitHub refused the credential. Deliberately narrow (credentials and scope,
 *  never "an error happened"): a false yes invites tearing down a working connection. Issue numbers must not appear
 *  in `noteGithubFailure` messages; a bare 401 counts only as a status code, not as prose. */
const AUTH_REFUSAL = [
  /^\s*401\s*[.,;:!]?\s*$/,
  /[([]\s*401\s*[)\]]/,
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
    // Reauth when the seal will not open or GitHub refused the credential on the last real call.
    reauthRequired: account !== null && (!connected || looksLikeAuthFailure(lastError)),
    clientIdConfigured: githubClientId() !== null,
    loginInProgress: flow !== null,
    userCode: flow?.userCode ?? null,
    verificationUri: flow?.verificationUri ?? null,
  };
}
