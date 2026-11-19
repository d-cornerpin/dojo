// THE ONE LIST OF CREDENTIAL SHAPES. The technique exporter replaces each secret with a {{NEEDS_FROM_USER:LABEL}}
// placeholder; every dojo_inspect view blanks the same spans (`inspect/redact.ts redactText`), in the same order.

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

/** A name whose last segment is a credential word (`token_count`, `tokenizer`, `secretary` are not). */
const CREDENTIAL_NAME = String.raw`[\w.-]*(?:(?<!(?:page|next|skip|continuation|sync|cursor)[_.-]?)token|secret|passw(?:or)?d|api[_-]?key|private[_-]?key)`;

/** Empty, a placeholder or reference, a number, a nothing-word, a type name, or a code expression. */
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
/** For a pair or a flag, also code (a placeholder, an object, a digit-free identifier, a very short word). */
export function notAPairedCredential(v: string, match: string): boolean {
  if (notACredentialLiteral(v)) return true;
  const quoted = match.endsWith(`"`) || match.endsWith(`'`);
  if (quoted) return /^[a-z]+(?:_[a-z]+)+$/.test(v);
  return /^[?:@]\w*$/.test(v) || /^[$({[`<]|^\/[^/]|^\/\^/.test(v) || (/^[A-Za-z_$][A-Za-z_$]*$/.test(v) && (v.length <= 20 || v.includes('_'))) || v.length < 6;
}

/** `-p` is also a port, "make parents" and a path flag: only a value with a letter and a digit and no path or space. */
function notAShortFlagPassword(v: string, match: string): boolean {
  if (notAPairedCredential(v, match)) return true;
  if (/[\\/]/.test(v)) return true;
  return /\s/.test(v) || !(/\d/.test(v) && /[A-Za-z]/.test(v));
}
const KEY_LIKE = String.raw`(?=[A-Za-z0-9_.~+/=-]*\d)(?=[A-Za-z0-9_.~+/=-]*[A-Za-z])[A-Za-z0-9_.~+/=-]{16,}`;

const PAIR_VALUE = String.raw`(?:"([^"\n]*)"|'([^'\n]*)'|([^\s,;"'}\])]+))`;
const GENERIC_HINT = 'A credential. Provide your own.';
/** A pair's placeholder label is its own name, upper snake case (`db.password` becomes DB_PASSWORD). */
const namedLabel = (m: RegExpExecArray): string => (/^[\w.-]+/.exec(m[0])?.[0] ?? 'credential').replace(/[.-]/g, '_').toUpperCase();

// The broad shapes first, then the labelled vendor shapes.
export const PATTERNS: Pattern[] = [
  { name: 'pem-private-key', regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g },
  { name: 'google-access-token', regex: /\bya29\.[A-Za-z0-9_-]{10,}/g },
  { name: 'google-refresh-token', regex: /(?<![\w/])1\/\/[A-Za-z0-9_-]{20,}/g },
  { name: 'github-fine-grained', regex: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { name: 'bearer-run', regex: /\bbearer\s+([^\s"'`,;<>)]{12,})/gi, keep: notACredentialLiteral, label: () => 'BEARER_TOKEN', hint: 'Bearer token used in an Authorization header.' },
  { name: 'basic-auth-header', regex: /\bauthorization["']?\s*[:=]\s*["']?basic\s+([A-Za-z0-9+/]{4,}={0,2})/gi },
  { name: 'basic-auth', regex: /\bBasic\s+((?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{8,}={0,2})/g },
  { name: 'url-creds', regex: /\b(?:https?|postgres(?:ql)?|mysql|mongodb|redis|amqp|ftp|ssh):\/\/[^\s:/@]+:[^\s/@]+@[^\s/]+/g, label: () => 'SERVICE_URL_WITH_CREDENTIALS', hint: 'A connection URL containing inline credentials. Provide the URL with your own user/password.' },
  { name: 'url-password-any-scheme', regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s/@]+)@/gi },
  { name: 'tunnel-token', regex: /\beyJ[A-Za-z0-9+/_-]{60,}={0,2}(?![A-Za-z0-9.])/g },
  { name: 'cookie-header', regex: /\b(?:set-)?cookie\s*:[ \t]*([^\r\n]+)/gi },
  { name: 'credential-flag', regex: /(?<![\w-])--?[\w-]*(?:token|password|passwd|secret|api-?key)(?:[ \t]+|=)(?!-)(?:"([^"\n]+)"|'([^'\n]+)'|([^\s"']+))/gi, keep: notAPairedCredential },
  { name: 'google-client-secret', regex: /\bGOCSPX-[A-Za-z0-9_-]{10,}/g },
  { name: 'google-api-key', regex: /\bAIza[0-9A-Za-z_-]{30,}/g, label: () => 'GOOGLE_API_KEY', hint: 'Google API key (starts with AIza). Get one from the Google Cloud Console.' },
  { name: 'password-short-flag', regex: /(?<![\w-])-p[ \t]+(?:"([^"\n]+)"|'([^'\n]+)'|([^\s"']+))/g, keep: notAShortFlagPassword },
  { name: 'credential-xml-element', regex: new RegExp(String.raw`<(${CREDENTIAL_NAME})(?:\s[^>]*)?>\s*(?:<!\[CDATA\[([^\]]*)\]\]>|([^<]*?))\s*</\1\s*>`, 'gi'), keep: notAPairedCredential },
  { name: 'key-query-parameter', regex: new RegExp(String.raw`(?<=[?&])[\w.-]*key=(${KEY_LIKE})`, 'gi') },
  { name: 'credential-pair-escaped', regex: new RegExp(String.raw`(?<![\w.-])${CREDENTIAL_NAME}\\"\s*:\s*\\"((?:[^"\\]|\\(?!"))+)\\"`, 'gi'), keep: notAPairedCredential },
  // `==`, `=>` and `=~` are comparisons, not assignments.
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
    regex: /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g,
    label: () => 'JWT_TOKEN',
    hint: 'JSON Web Token (JWT). Typically a session or bearer token — get a fresh one for your install.',
  },
  {
    name: 'bearer-header',
    regex: /\b[Bb]earer\s+([a-zA-Z0-9._-]{20,})\b/g,
    label: () => 'BEARER_TOKEN',
    hint: 'Bearer token used in an Authorization header.',
  },
  {
    name: 'env-secret-assignment',
    // A value of 12 or more with no spaces, so `API_KEY=<your-key-here>` is left alone.
    regex: /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|API_KEY|APIKEY|PASSWORD|PASSWD|PRIVATE_KEY))\s*[:=]\s*['"]?([^'"\s<>{}]{12,})['"]?/g,
    label: (m) => m[1].replace(/^[A-Z_]+_/, '') ? m[1] : m[1],
    hint: 'An environment variable holding a credential.',
  },
];

// Binary files are never scrubbed line by line.
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

/** Scrub `files`: the content of each file that had a match, every redaction, and the de-duplicated placeholders. */
export function scrubFiles(files: Array<{ path: string; content: string }>): ScrubResult {
  const scrubbed = new Map<string, string>();
  const redactions: Redaction[] = [];
  const seenLabels = new Set<string>();
  const placeholders: Array<{ label: string; hint: string }> = [];

  // Two GitHub tokens become GITHUB_TOKEN and GITHUB_TOKEN_2, not one placeholder for two values;
  // one value keeps its first label wherever it appears again.
  const labelCounts = new Map<string, number>();
  const labelByValue = new Map<string, string>();

  for (const file of files) {
    if (isBinaryFile(file.path)) continue;

    let content = file.content;
    let dirty = false;

    for (const pattern of PATTERNS) {
      content = content.replace(pattern.regex, (match, ...rest) => {
        const secret = secretOf(pattern, match, rest);
        if (secret === null || (secret || match).includes('{{NEEDS_FROM_USER:')) return match;   // a placeholder is never wrapped again
        // Build a fake exec result so the label() callback can use capture groups.
        const execLike = Object.assign([match, ...rest.slice(0, -2)] as unknown as RegExpExecArray, {
          index: 0,
          input: match,
        });
        const baseLabel = pattern.label?.(execLike) ?? 'CREDENTIAL';
        const hint = pattern.hint ?? GENERIC_HINT;
        const value = secret || match;
        let label = labelByValue.get(value);
        if (!label) {
          const count = (labelCounts.get(baseLabel) ?? 0) + 1;
          labelCounts.set(baseLabel, count);
          label = count === 1 ? baseLabel : `${baseLabel}_${count}`;
          labelByValue.set(value, label);
        }

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
