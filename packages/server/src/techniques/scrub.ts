// ════════════════════════════════════════
// Technique Secret Scrubber
// ════════════════════════════════════════
//
// THE ONE LIST OF CREDENTIAL SHAPES. The technique exporter replaces each match with a {{NEEDS_FROM_USER:LABEL}}
// placeholder before a package is shipped (a Trainer review pass follows), and every dojo_inspect view blanks the same
// matches (`inspect/redact.ts redactText`). Both apply the whole list in the same order, so a span either use blanked
// is blanked by both. The LAST capture group (or the whole match when there is none) is the secret; `keep` may veto a
// match that is code, a number or a placeholder rather than a credential.

export interface Redaction {
  file: string;       // relative path inside the technique dir
  label: string;      // placeholder label (UPPER_SNAKE)
  matched: string;    // the literal string that was redacted (NEVER include in exported manifest)
  hint: string;       // human-readable hint for the README
  pattern: string;    // which pattern matched (for debugging)
}

export interface ScrubResult {
  scrubbed: Map<string, string>;        // file -> redacted content
  redactions: Redaction[];               // every redaction, including original value (caller decides what to ship)
  placeholders: Array<{ label: string; hint: string }>;  // de-duped list safe to export in manifest
}

export interface Pattern {
  name: string;
  regex: RegExp;
  /** The exporter's placeholder label and README hint (a shape with none is a generic credential). */
  label?: (m: RegExpExecArray) => string;
  hint?: string;
  keep?: (value: string, match: string) => boolean;
}

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

/** The short password flag `-p <value>` (a sshpass or mysql-style call). `-p` is also a port, a
 *  "make parents" flag and a path flag, so a value is blanked only when it is not code, not a number,
 *  not a path or a phrase with spaces, and carries both a letter and a digit the way a generated password does. */
function notAShortFlagPassword(v: string, match: string): boolean {
  if (notAPairedCredential(v, match)) return true;
  if (/[\\/]/.test(v)) return true;
  return /\s/.test(v) || !(/\d/.test(v) && /[A-Za-z]/.test(v));
}
/** A query-parameter value that looks like a key: long, one unbroken run, letters and digits both. */
const KEY_LIKE = String.raw`(?=[A-Za-z0-9_.~+/=-]*\d)(?=[A-Za-z0-9_.~+/=-]*[A-Za-z])[A-Za-z0-9_.~+/=-]{16,}`;

const PAIR_VALUE = String.raw`(?:"([^"\n]*)"|'([^'\n]*)'|([^\s,;"'}\])]+))`;
const GENERIC_HINT = 'A credential. Provide your own.';
/** A pair's placeholder label is its own name, upper snake case (`db.password` becomes DB_PASSWORD). */
const namedLabel = (m: RegExpExecArray): string => (/^[\w.-]+/.exec(m[0])?.[0] ?? 'credential').replace(/[.-]/g, '_').toUpperCase();

// The broad shapes first (a whole bearer run, a key/value pair), then the labelled vendor shapes.
export const PATTERNS: Pattern[] = [
  // Whole PEM block; a block cut off before its END line is blanked to the end of the text.
  { name: 'pem-private-key', regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g },
  { name: 'google-access-token', regex: /\bya29\.[A-Za-z0-9_-]{10,}/g },
  { name: 'google-refresh-token', regex: /(?<![\w/])1\/\/[A-Za-z0-9_-]{20,}/g },
  { name: 'github-fine-grained', regex: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  // The whole run after `Bearer` (Microsoft tokens carry + / = ! * $ ~), not the exporter's narrower run.
  { name: 'bearer-run', regex: /\bbearer\s+([^\s"'`,;<>)]{12,})/gi, keep: notACredentialLiteral, label: () => 'BEARER_TOKEN', hint: 'Bearer token used in an Authorization header.' },
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
  // Google OAuth client secret, and Google API keys (the shapes of the Google accounts the Dojo stores).
  { name: 'google-client-secret', regex: /\bGOCSPX-[A-Za-z0-9_-]{10,}/g },
  { name: 'google-api-key', regex: /\bAIza[0-9A-Za-z_-]{30,}/g, label: () => 'GOOGLE_API_KEY', hint: 'Google API key (starts with AIza). Get one from the Google Cloud Console.' },
  // The short password flag with its value after a space: -p <value>.
  { name: 'password-short-flag', regex: /(?<![\w-])-p[ \t]+(?:"([^"\n]+)"|'([^'\n]+)'|([^\s"']+))/g, keep: notAShortFlagPassword },
  // A credential written as an XML element: <password>value</password>, with or without CDATA.
  { name: 'credential-xml-element', regex: new RegExp(String.raw`<(${CREDENTIAL_NAME})(?:\s[^>]*)?>\s*(?:<!\[CDATA\[([^\]]*)\]\]>|([^<]*?))\s*</\1\s*>`, 'gi'), keep: notAPairedCredential },
  // A generic key= query parameter (?key=, &access_key=), blanked only when the value looks like a key.
  { name: 'key-query-parameter', regex: new RegExp(String.raw`(?<=[?&])[\w.-]*key=(${KEY_LIKE})`, 'gi') },
  // JSON that is itself inside a JSON string: a quoted credential name, then a quoted value, both escaped.
  { name: 'credential-pair-escaped', regex: new RegExp(String.raw`(?<![\w.-])${CREDENTIAL_NAME}\\"\s*:\s*\\"((?:[^"\\]|\\(?!"))+)\\"`, 'gi'), keep: notAPairedCredential },
  // A name that ENDS in a credential word, in JSON, `name=value` or `name: value`, any case.
  // Key and punctuation stay; `==`, `=>` and `=~` are comparisons, not assignments.
  { name: 'credential-pair', regex: new RegExp(String.raw`(?<![\w.-])${CREDENTIAL_NAME}["'\`]?[ \t]*[:=](?![=>~])(?:[ \t]*|[ \t]*\r?\n[ \t]+)${PAIR_VALUE}`, 'gi'), keep: notAPairedCredential, label: namedLabel, hint: 'A credential assigned to a named setting.' },

  {
    name: 'anthropic-key',
    regex: /\bsk-ant-[a-zA-Z0-9_-]{20,}/g,
    label: () => 'ANTHROPIC_API_KEY',
    hint: 'Anthropic API key (starts with sk-ant-). Get one at https://console.anthropic.com/.',
  },
  {
    name: 'openai-key',
    regex: /\bsk-(?:proj-)?[a-zA-Z0-9_-]{20,}/g,
    label: () => 'OPENAI_API_KEY',
    hint: 'OpenAI API key (starts with sk- or sk-proj-). Get one at https://platform.openai.com/api-keys.',
  },
  {
    name: 'github-token',
    regex: /\bghp_[a-zA-Z0-9]{30,}\b/g,
    label: () => 'GITHUB_TOKEN',
    hint: 'GitHub personal access token (starts with ghp_). Generate at https://github.com/settings/tokens.',
  },
  {
    name: 'github-oauth',
    regex: /\bgho_[a-zA-Z0-9]{30,}\b/g,
    label: () => 'GITHUB_OAUTH_TOKEN',
    hint: 'GitHub OAuth token (starts with gho_).',
  },
  {
    name: 'github-app',
    regex: /\b(?:ghu_|ghs_|ghr_)[a-zA-Z0-9]{30,}\b/g,
    label: () => 'GITHUB_APP_TOKEN',
    hint: 'GitHub App / user access token.',
  },
  {
    name: 'huggingface-key',
    regex: /\bhf_[a-zA-Z0-9]{30,}\b/g,
    label: () => 'HUGGINGFACE_TOKEN',
    hint: 'Hugging Face access token (starts with hf_). Get one at https://huggingface.co/settings/tokens.',
  },
  {
    name: 'slack-bot',
    regex: /\bxox[abprs]-[a-zA-Z0-9-]{20,}\b/g,
    label: () => 'SLACK_TOKEN',
    hint: 'Slack token (starts with xoxb-, xoxa-, xoxp-, xoxr-, or xoxs-).',
  },
  {
    name: 'aws-access-key',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    label: () => 'AWS_ACCESS_KEY_ID',
    hint: 'AWS access key ID (starts with AKIA or ASIA). The matching secret key must also be replaced.',
  },
  {
    name: 'stripe-key',
    regex: /\b(?:sk|pk|rk)_(?:test|live)_[a-zA-Z0-9]{20,}\b/g,
    label: (m) => /^pk_/.test(m[0]) ? 'STRIPE_PUBLISHABLE_KEY' : 'STRIPE_SECRET_KEY',
    hint: 'Stripe API key. Get one from https://dashboard.stripe.com/apikeys.',
  },
  {
    name: 'jwt',
    // Three base64url segments joined by dots — JWT shape. Min lengths keep
    // it from matching random short tokens like git SHAs.
    regex: /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g,
    label: () => 'JWT_TOKEN',
    hint: 'JSON Web Token (JWT). Typically a session or bearer token — get a fresh one for your install.',
  },
  {
    name: 'url-creds',
    // URLs with user:pass@host — postgres://user:secret@host etc.
    regex: /\b(?:https?|postgres(?:ql)?|mysql|mongodb|redis|amqp|ftp|ssh):\/\/[^\s:/@]+:[^\s/@]+@[^\s/]+/g,
    label: () => 'SERVICE_URL_WITH_CREDENTIALS',
    hint: 'A connection URL containing inline credentials. Provide the URL with your own user/password.',
  },
  {
    name: 'bearer-header',
    // Authorization: Bearer <token> — catch the value
    regex: /\b[Bb]earer\s+([a-zA-Z0-9._-]{20,})\b/g,
    label: () => 'BEARER_TOKEN',
    hint: 'Bearer token used in an Authorization header.',
  },
  {
    name: 'env-secret-assignment',
    // FOO_TOKEN="..." / FOO_SECRET=..., common in .env style or inline.
    // Captures the assigned value — only flags assignments that look like
    // real values (length >= 12, no spaces), so we don't redact
    // documentation lines like `API_KEY=<your-key-here>`.
    regex: /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|API_KEY|APIKEY|PASSWORD|PASSWD|PRIVATE_KEY))\s*[:=]\s*['"]?([^'"\s<>{}]{12,})['"]?/g,
    label: (m) => m[1].replace(/^[A-Z_]+_/, '') ? m[1] : m[1],
    hint: 'An environment variable holding a credential.',
  },
];

// Files we never scrub line-by-line because they're binary or huge — skip
// entirely and emit a redaction note so the README mentions them.
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico',
  '.pdf', '.zip', '.tar', '.gz', '.tgz',
  '.mp3', '.mp4', '.wav', '.mov', '.avi',
  '.docx', '.xlsx', '.pptx',
  '.sqlite', '.db',
]);

/** The secret span of a match: its last non-empty capture group, '' for the whole match, or null when `keep` vetoes it. */
export function secretOf(p: Pattern, match: string, rest: unknown[]): string | null {
  const groups = rest.slice(0, -2).filter((g): g is string => typeof g === 'string' && g.length > 0);
  const value = groups[groups.length - 1];
  if (p.keep && (!value || p.keep(value, match))) return null;
  return value ?? '';
}

export function isBinaryFile(relPath: string): boolean {
  const idx = relPath.lastIndexOf('.');
  if (idx < 0) return false;
  return BINARY_EXTENSIONS.has(relPath.slice(idx).toLowerCase());
}

/**
 * Run the deterministic scrubber over a set of files.
 *
 * Returns a map of file → redacted-content for every file that had at
 * least one match (callers can write those back to disk in a staging
 * dir before zipping), plus the full redactions list and a de-duped
 * placeholder summary for the manifest.
 *
 * Files passed in but not present in the returned map were clean.
 */
export function scrubFiles(files: Array<{ path: string; content: string }>): ScrubResult {
  const scrubbed = new Map<string, string>();
  const redactions: Redaction[] = [];
  const seenLabels = new Set<string>();
  const placeholders: Array<{ label: string; hint: string }> = [];

  // Count how many times we've used a label so a technique with two
  // GitHub tokens gets GITHUB_TOKEN and GITHUB_TOKEN_2, not two
  // collisions that round-trip to the same value on import.
  const labelCounts = new Map<string, number>();

  for (const file of files) {
    if (isBinaryFile(file.path)) continue;

    let content = file.content;
    let dirty = false;

    for (const pattern of PATTERNS) {
      // We re-execute against the freshly-scrubbed content each iteration
      // so an earlier replacement doesn't double-count and so the regex's
      // lastIndex state stays consistent.
      content = content.replace(pattern.regex, (match, ...rest) => {
        const secret = secretOf(pattern, match, rest);
        if (secret === null) return match;
        // Build a fake exec result so the label() callback can use capture groups.
        const execLike = Object.assign([match, ...rest.slice(0, -2)] as unknown as RegExpExecArray, {
          index: 0,
          input: match,
        });
        const baseLabel = pattern.label?.(execLike) ?? 'CREDENTIAL';
        const hint = pattern.hint ?? GENERIC_HINT;
        const count = (labelCounts.get(baseLabel) ?? 0) + 1;
        labelCounts.set(baseLabel, count);
        const label = count === 1 ? baseLabel : `${baseLabel}_${count}`;

        redactions.push({
          file: file.path,
          label,
          matched: match,
          hint,
          pattern: pattern.name,
        });
        if (!seenLabels.has(label)) {
          seenLabels.add(label);
          placeholders.push({ label, hint });
        }
        dirty = true;
        const placeholder = `{{NEEDS_FROM_USER:${label}}}`;
        const idx = secret === '' ? -1 : match.lastIndexOf(secret);
        return idx < 0 ? placeholder : match.slice(0, idx) + placeholder + match.slice(idx + secret.length);
      });
    }

    if (dirty) {
      scrubbed.set(file.path, content);
    }
  }

  return { scrubbed, redactions, placeholders };
}
