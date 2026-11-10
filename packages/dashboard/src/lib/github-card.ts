// What the GitHub card may say: total functions of the served status; the server suite drives them as rules.

/** Structural, not imported: api.ts would drag fetch and auth into a module the server suite imports. */
export interface GithubCardStatus {
  connected: boolean;
  scope: string | null;
  reauthRequired: boolean;
  clientIdConfigured: boolean;
  loginInProgress: boolean;
  userCode: string | null;
  verificationUri: string | null;
}

/** The four mutually exclusive render states. Exhaustive: every status maps to exactly one. */
export type GithubCardState = 'connecting' | 'connected' | 'unconfigured' | 'disconnected';

/** The order is the whole decision. Connecting wins, but only with code AND link: a restart can strand
 *  the flag. Connected outranks unconfigured: clearing the client id does not unseal a stored token. */
export const githubCardState = (s: GithubCardStatus): GithubCardState => {
  if (s.loginInProgress && s.userCode !== null && s.verificationUri !== null) return 'connecting';
  if (s.connected) return 'connected';
  if (!s.clientIdConfigured) return 'unconfigured';
  return 'disconnected';
};

export const connectLabel = (s: GithubCardStatus): string =>
  (s.reauthRequired ? 'Reconnect GitHub' : 'Connect GitHub');

/** Restated from the server's device-flow (no cross-package import); the server suite pins equality. */
export const GITHUB_EXPECTED_SCOPE = 'public_repo';

/** What the token can do, from the STORED scope, never the asked-for one: the box may hold a wider grant. */
export const describeScope = (scope: string | null): string => {
  if (scope === GITHUB_EXPECTED_SCOPE) {
    return 'It can create issues on public repositories, and GitHub\'s permission for that also covers changing your own public repositories (the Dojo only files reports). It cannot read your private repositories.';
  }
  const recorded = (scope ?? '').trim();
  if (recorded === '') {
    return 'GitHub did not record which permissions this connection holds. '
      + 'Disconnect and connect again if you want it narrowed to issues on public repositories.';
  }
  return `GitHub granted this connection "${recorded}", which is not the single `
    + `"${GITHUB_EXPECTED_SCOPE}" permission the Dojo asks for. Disconnect and connect again to narrow it.`;
};

export const scopeRequestSentence = (): string => {
  if (GITHUB_EXPECTED_SCOPE === 'public_repo') {
    return 'It asks for one permission, GitHub\'s "public_repo": it lets the Dojo create issues on public repositories, '
      + 'and it also covers changing your own public repositories (the Dojo only files reports). It cannot read your private repositories.';
  }
  return `It asks GitHub for "${GITHUB_EXPECTED_SCOPE}". `
    + 'Check what that permission allows before you connect.';
};

export const CONNECT_FAILED_FALLBACK = 'The GitHub sign-in stopped without connecting.';
export const CONNECT_REFUSED_FALLBACK = 'GitHub would not start a sign-in.';

export const problemText = (err: string | null | undefined, fallback: string): string => {
  const text = (err ?? '').trim();
  return text === '' ? fallback : text;
};

/** The one-time GET /user can fail on a hiccup; a network blip costs the name, never the connection. */
export const connectedAs = (login: string | null): string => {
  const name = (login ?? '').trim();
  return name === '' ? 'Connected' : `Connected as ${name}`;
};
