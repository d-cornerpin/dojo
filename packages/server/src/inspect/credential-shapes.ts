// t285 R1 / F3 / F4 — credential shapes for the dojo_inspect scrubber (`redact.ts` `redactText`).
//
// The shapes the Dojo itself stores or handles (google_accounts / microsoft_accounts tokens,
// agent_credentials, provider keys, the GitHub connection, the tunnel token, twilio) that the
// exporter's list (`techniques/scrub.ts`) does not know. Owned HERE, not in the exporter: it swaps
// matches for placeholders a recipient must fill, and these are broader than it should be.
// A match that is not a credential costs a blank in a read-only view and cannot leak, but the code
// view reads the Dojo's own source, so the key/value rule is narrow (below): the NAME must END in a
// credential word and the VALUE must look like a literal, never a number, a flag or code.
// The LAST capture group (or the whole match when there is none) is what is blanked; `keep` may
// veto a match.

export interface InspectPattern { name: string; regex: RegExp; keep?: (value: string, match: string) => boolean }

/** A name whose last segment (`_`, `-`, `.` or camelCase) is a credential word. `tokens`, `tokenizer`,
 *  `secretary`, `token_count`, `secret_path` do not end in one. */
const CREDENTIAL_NAME = String.raw`[\w.-]*(?:token|secret|passw(?:or)?d|api[_-]?key|private[_-]?key)`;

/** A value that is not a credential literal: empty, a placeholder or reference, a number, a flag or
 *  nothing-word, a type name, or a code expression (a call, an index, a member path). */
const TYPE_WORDS = /^(?:string|number|boolean|any|unknown|object|void|never|bigint|symbol|str|int|bool|bytes)$/i;
const NOTHING = /^(?:true|false|null|undefined|none|nil|nan)$/i;
const MEMBER_PATH = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+$/;
export function notACredentialLiteral(v: string): boolean {
  const t = v.trim().replace(/[`.;,:]+$/, '');
  if (t === '' || /^\.+$|^[*x…-]{3,}$/.test(t) || /^<.*>$/.test(t) || /^\$\{.*\}$|^\$[A-Za-z_]\w*$|^%\(\w+\)s$|^\{\{.*\}\}$/.test(t)) return true;
  if (/^[-+]?\d[\d_.,]*$/.test(t) || NOTHING.test(t) || TYPE_WORDS.test(t)) return true;
  if (/[()[\]]/.test(t) && /^[A-Za-z_$][\w$.?]*[([]/.test(t)) return true;
  return MEMBER_PATH.test(t) && !/\d/.test(t);
}
/** For a key/value pair or a flag: also not a credential when the value is code (a placeholder
 *  `?`/`$1`, a brace or bracket opening an object, a digit-free identifier, a very short word)
 *  rather than a quoted string or a generated secret. Real credentials the Dojo handles carry digits. */
export function notAPairedCredential(v: string, match: string): boolean {
  if (notACredentialLiteral(v)) return true;
  const quoted = match.endsWith(`"`) || match.endsWith(`'`);
  if (quoted) return /^[a-z]+(?:_[a-z]+)+$/.test(v);
  return /^[?:@]\w*$/.test(v) || /^[$({[`<]|^\/[^/]|^\/\^/.test(v) || (/^[A-Za-z_$][A-Za-z_$]*$/.test(v) && (v.length <= 20 || v.includes('_'))) || v.length < 6;
}

const PAIR_VALUE = String.raw`(?:"([^"\n]*)"|'([^'\n]*)'|([^\s,;"'}\])]+))`;
export const INSPECT_PATTERNS: ReadonlyArray<InspectPattern> = [
  // Whole PEM block; a block cut off before its END line is blanked to the end of the text.
  { name: 'pem-private-key', regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g },
  { name: 'google-access-token', regex: /\bya29\.[A-Za-z0-9_-]{10,}/g },
  { name: 'google-refresh-token', regex: /(?<![\w/])1\/\/[A-Za-z0-9_-]{20,}/g },
  { name: 'github-fine-grained', regex: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  // The whole run after `Bearer` (Microsoft tokens carry + / = ! * $ ~), not the exporter's narrower run.
  { name: 'bearer-run', regex: /\bbearer\s+([^\s"'`,;<>)]{12,})/gi, keep: notACredentialLiteral },
  // `Authorization: Basic <b64>` (any case), and a bare `Basic <b64>` that looks encoded (has a digit, + / or =).
  { name: 'basic-auth-header', regex: /\bauthorization["']?\s*[:=]\s*["']?basic\s+([A-Za-z0-9+/]{4,}={0,2})/gi },
  { name: 'basic-auth', regex: /\bBasic\s+((?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{8,}={0,2})/g },
  // A password in a URL of any scheme: scheme://user:password@host.
  { name: 'url-password-any-scheme', regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s/@]+)@/gi },
  // The bare tunnel token: long base64 starting eyJ with no dots (a JWT has dots and is the exporter's).
  { name: 'tunnel-token', regex: /\beyJ[A-Za-z0-9+/_-]{60,}={0,2}(?![A-Za-z0-9.])/g },
  // A cookie header carries session credentials.
  { name: 'cookie-header', regex: /\b(?:set-)?cookie\s*:[ \t]*([^\r\n]+)/gi },
  // A command-line flag naming a credential, value after a space or `=`: --token <v>, --api-key=<v>.
  { name: 'credential-flag', regex: /(?<![\w-])--?[\w-]*(?:token|password|passwd|secret|api-?key)(?:[ \t]+|=)(?!-)(?:"([^"\n]+)"|'([^'\n]+)'|([^\s"']+))/gi, keep: notAPairedCredential },
  // JSON that is itself inside a JSON string: \"access_token\":\"...\".
  { name: 'credential-pair-escaped', regex: new RegExp(String.raw`(?<![\w.-])${CREDENTIAL_NAME}\\"\s*:\s*\\"((?:[^"\\]|\\(?!"))+)\\"`, 'gi'), keep: notAPairedCredential },
  // A name that ENDS in a credential word, in JSON, `name=value` or `name: value`, any case.
  // Key and punctuation stay; `==`, `=>` and `=~` are comparisons, not assignments.
  { name: 'credential-pair', regex: new RegExp(String.raw`(?<![\w.-])${CREDENTIAL_NAME}["'\`]?[ \t]*[:=](?![=>~])(?:[ \t]*|[ \t]*\r?\n[ \t]+)${PAIR_VALUE}`, 'gi'), keep: notAPairedCredential },
];
