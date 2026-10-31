// t285 R1 — credential shapes for the dojo_inspect scrubber (`redact.ts` `redactText`).

/** t285 R1 — the shapes the Dojo itself stores or handles (google_accounts / microsoft_accounts
 *  tokens, agent_credentials, provider keys, the GitHub connection, twilio) that the exporter's
 *  list does not know. Owned HERE, not in `techniques/scrub.ts`: the exporter swaps matches for
 *  placeholders a recipient must fill, and these are broader than it should be. A match that is
 *  not a credential costs a blank in a read-only view and cannot leak. The LAST capture group
 *  (or the whole match when there is none) is what is blanked. */
const CREDENTIAL_NAME = String.raw`[\w.-]*(?:access_token|refresh_token|id_token|auth_token|client_secret|secret|api[_-]?key|private[_-]?key|passwd|password|token)[\w.-]*`;
export const INSPECT_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  // Whole PEM block; a block cut off before its END line is blanked to the end of the text.
  { name: 'pem-private-key', regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g },
  { name: 'google-access-token', regex: /\bya29\.[A-Za-z0-9_-]{10,}/g },
  { name: 'google-refresh-token', regex: /(?<![\w/])1\/\/[A-Za-z0-9_-]{20,}/g },
  { name: 'github-fine-grained', regex: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  // `Authorization: Basic <b64>` (any case), and a bare `Basic <b64>` that looks encoded (has a digit, + / or =).
  { name: 'basic-auth-header', regex: /\bauthorization["']?\s*[:=]\s*["']?basic\s+([A-Za-z0-9+/]{4,}={0,2})/gi },
  { name: 'basic-auth', regex: /\bBasic\s+((?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{8,}={0,2})/gi },
  // A key that names a credential, in JSON, `name=value` or `name: value`, any case. Key and punctuation stay.
  { name: 'credential-pair', regex: new RegExp(String.raw`(?<![\w.-])${CREDENTIAL_NAME}["']?\s*[:=]\s*(?:"([^"\n]+)"|'([^'\n]+)'|([^\s,;"'}\])]+))`, 'gi') },
];

