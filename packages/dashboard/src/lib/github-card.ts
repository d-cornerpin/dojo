// ════════════════════════════════════════════════════════════════════════════════════════
// WHAT THE GITHUB CARD IS ALLOWED TO SAY, AS FOUR DECISIONS SOMETHING CAN ARGUE WITH.
//
// ── WHY THIS IS NOT IN `GitHubSettings.tsx` ──
// `packages/dashboard` has NO test runner, so every rule that stays inside a `.tsx` file is a
// rule nothing checks. The v3.1.27 precedent is `lib/provider-edits.ts`, whose header says the
// same thing and whose rules are held from `packages/server`'s suite by direct import. The
// rules below are the ones where being wrong is a LIE ABOUT A CONNECTION rather than a cosmetic
// slip, so they live here and the server-side suite drives them against the real engine doors.
//
// ── THE DOCTRINE THESE FOUR DECISIONS SERVE (`memory/integration-status-lane.ts`, the ".24"
//    rule) ── *"The agent must never have to trust a notebook entry saying a connection is
// broken. The PLATFORM'S LIVE TRUTH sits in front of it every turn and OUTRANKS memory."* And
// the discipline that keeps that honest: ledger-backed, never an invented freshness.
//
// So every function here is a TOTAL function of the SERVED `GithubStatus` and nothing else. No
// local component state is consulted, no timer, no "probably still connected", and no field is
// re-derived from another (the `.26` Health-page lesson: a client that guesses the wire shape is
// a lie held together by a remap). `GitHubSettings.tsx` holds exactly one thing these do not —
// the text of the last `github:connect_failed` frame, which is on the wire and in no ledger —
// and that exception is written down in the T5 report as unheld rather than left to be found.
// ════════════════════════════════════════════════════════════════════════════════════════

/**
 * The fields of the served `GithubStatus` these decisions read.
 *
 * DECLARED STRUCTURALLY, NOT IMPORTED, and that is deliberate on both ends: importing
 * `lib/api.ts` would drag `fetch`, `document.cookie` and the auth token into a module the
 * server's vitest imports directly. `api.GithubStatus` satisfies this shape structurally, and
 * the suite pins the agreement by passing a REAL `githubStatus()` result through every function
 * below — so a field renamed on the wire fails a test rather than rendering a blank.
 */
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

/**
 * THE PRECEDENCE, AND WHY IT IS THIS ORDER.
 *
 * The four states overlap in reality — `connected` and `loginInProgress` can both be true, and
 * so can `connected` and `!clientIdConfigured` — so the order is the whole decision, not a
 * detail of how it happens to be written.
 *
 * 1. CONNECTING WINS OVER EVERYTHING. A user who has just pressed Connect is mid-act and needs
 *    the code on screen; a card that showed "Connected" over an open sign-in would swallow the
 *    one thing the user is waiting for. It also covers the reconnect-while-connected case,
 *    which is exactly what `reauthRequired` asks the user to do.
 *
 *    It requires the CODE AND THE LINK, not just the flag. T4's hand-off note 5 is the reason:
 *    the flow is one module variable in one process, so a server restart mid-sign-in leaves a
 *    card that would otherwise wait forever on a code nobody is polling. A "connecting" state
 *    with nothing to type is that defect rendered; without the code, this falls through to a
 *    state with a button the user can press.
 *
 * 2. CONNECTED OUTRANKS UNCONFIGURED. This is the .24 doctrine in its sharpest form: a client
 *    id cleared after the fact does NOT unseal the stored token and does NOT stop T7 posting
 *    with it. Answering "GitHub isn't set up on this box yet" while a working connection sits
 *    in the ledger would be the card inventing a disconnection — the same class of lie as
 *    inventing a freshness, one surface over.
 *
 * 3. UNCONFIGURED before DISCONNECTED, because the difference the user needs is whether there
 *    is anything they can press. No client id means Connect cannot work, so no button is drawn.
 *
 * 4. Otherwise DISCONNECTED — which includes `reauthRequired` (a stored row whose token will
 *    not open, or a last outcome GitHub rejected). Reauth is not a fifth state: it is the
 *    disconnected state with a reason, exactly as `PlaudSettings.tsx` renders its own.
 */
export const githubCardState = (s: GithubCardStatus): GithubCardState => {
  if (s.loginInProgress && s.userCode !== null && s.verificationUri !== null) return 'connecting';
  if (s.connected) return 'connected';
  if (!s.clientIdConfigured) return 'unconfigured';
  return 'disconnected';
};

/** The button's word. Reconnect is not a different button — it is an honest label on the one. */
export const connectLabel = (s: GithubCardStatus): string =>
  (s.reauthRequired ? 'Reconnect GitHub' : 'Connect GitHub');

/**
 * The one scope this feature asks for, restated from `github/device-flow.ts`'s
 * `GITHUB_OAUTH_SCOPE`. `packages/dashboard` cannot import from `packages/server`, so it is
 * restated — and the server-side suite asserts the two constants are the SAME STRING, so the
 * day GitHub hands this box something wider, the sentence below stops being said.
 */
export const GITHUB_EXPECTED_SCOPE = 'public_repo';

/**
 * What the token can actually do, in words, DERIVED FROM THE STORED SCOPE — never from the
 * scope we asked for.
 *
 * This is the rule with teeth. The reassurance *"It can't read your private repositories"* is
 * true of `public_repo` and FALSE of `repo`, and which one this box holds is a fact GitHub
 * decided at grant time and wrote into the ledger. A card that printed the reassurance from a
 * constant would keep printing it after an OAuth App was re-registered with a wider scope — a
 * claim about the user's private code that nothing measured. So: the exact expected scope gets
 * the reassurance, and every other value — wider, empty, unrecorded, or simply unrecognised —
 * gets a sentence that names what is recorded and reassures about nothing.
 */
export const describeScope = (scope: string | null): string => {
  if (scope === GITHUB_EXPECTED_SCOPE) {
    return 'It can create issues on public repositories. It cannot read your private repositories.';
  }
  const recorded = (scope ?? '').trim();
  if (recorded === '') {
    return 'GitHub did not record which permissions this connection holds. '
      + 'Disconnect and connect again if you want it narrowed to issues on public repositories.';
  }
  return `GitHub granted this connection "${recorded}", which is not the single `
    + `"${GITHUB_EXPECTED_SCOPE}" permission the Dojo asks for. Disconnect and connect again to narrow it.`;
};

/**
 * What the card says it is ABOUT to ask for, before the user presses Connect.
 *
 * ── FIX ROUND 1 (review F3). WHY THIS IS NOT A STRING IN THE JSX, WHICH IS WHERE IT WAS ──
 * The card carried its own copy of this sentence, worded differently ("private repos" rather
 * than "private repositories") so that no grep over the tested wording found it. That copy was
 * exactly what `describeScope` above exists to forbid: a CONSTANT claim about the user's
 * private code, living in the one file with no test runner. Both sentences now hang off
 * `GITHUB_EXPECTED_SCOPE`, which the server-side suite pins to the engine's own
 * `GITHUB_OAUTH_SCOPE` — so if the scope this box asks for ever widens, neither sentence can
 * keep reassuring anybody. A census over `GitHubSettings.tsx` refuses a third copy.
 *
 * The difference from `describeScope`: that one describes what GitHub GRANTED (past tense, read
 * from the ledger), this one describes what we will ASK FOR (future tense, read from the
 * constant). They are different claims and only one of them has a ledger behind it.
 */
export const scopeRequestSentence = (): string => {
  if (GITHUB_EXPECTED_SCOPE === 'public_repo') {
    return 'It asks for one permission: creating issues on public repositories. '
      + 'It cannot read your private repositories.';
  }
  return `It asks GitHub for "${GITHUB_EXPECTED_SCOPE}". `
    + 'Check what that permission allows before you connect.';
};

/** A sign-in that stopped after it had started. */
export const CONNECT_FAILED_FALLBACK = 'The GitHub sign-in stopped without connecting.';
/** A sign-in that never started — `POST /connect` refused it. A different question. */
export const CONNECT_REFUSED_FALLBACK = 'GitHub would not start a sign-in.';

/**
 * The text of a sign-in that did not finish — from the `github:connect_failed` frame, or from a
 * refused `POST /connect`.
 *
 * ── FIX ROUND 1: the decidable half of the one state with no ledger behind it ──
 * The T5 report listed this as unheld because it is an EVENT, with no door to drive. That is
 * true of the WIRING and false of the DECISION. A failed sign-in that renders an empty box, or
 * the word `null`, tells the user nothing went wrong when something did — which is nearer a
 * claim about the connection than a cosmetic slip, and that is this module's own test for what
 * belongs here.
 */
export const problemText = (err: string | null | undefined, fallback: string): string => {
  const text = (err ?? '').trim();
  return text === '' ? fallback : text;
};

/**
 * The connected-state headline. T4 hand-off note 6: `GET /user` is called once with the fresh
 * token and is not retried, so a network hiccup at that moment costs the NAME and never the
 * connection. The card must render that case as a connection without a name — printing
 * `Connected as null` is the shape of bug this exists to make impossible.
 */
export const connectedAs = (login: string | null): string => {
  const name = (login ?? '').trim();
  return name === '' ? 'Connected' : `Connected as ${name}`;
};
