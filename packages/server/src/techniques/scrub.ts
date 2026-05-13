// ════════════════════════════════════════
// Technique Secret Scrubber
// ════════════════════════════════════════
//
// Deterministic pass that replaces recognized secret patterns in technique
// files with {{NEEDS_FROM_USER:LABEL}} placeholders before the package is
// shipped to another Dojo. Followed by a Trainer (Yoshi) review pass that
// catches anything the regexes miss and writes the README.

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

interface Pattern {
  name: string;
  regex: RegExp;
  label: (m: RegExpExecArray) => string;
  hint: string;
}

// Pattern ordering matters: longer / more specific patterns first so a
// generic catch-all doesn't swallow something a labelled pattern would
// have tagged more usefully.
const PATTERNS: Pattern[] = [
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
    name: 'google-api-key',
    regex: /\bAIza[a-zA-Z0-9_-]{35}\b/g,
    label: () => 'GOOGLE_API_KEY',
    hint: 'Google API key (starts with AIza). Get one from the Google Cloud Console.',
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
        // Build a fake exec result so the label() callback can use capture groups.
        const execLike = Object.assign([match, ...rest.slice(0, -2)] as unknown as RegExpExecArray, {
          index: 0,
          input: match,
        });
        const baseLabel = pattern.label(execLike);
        const count = (labelCounts.get(baseLabel) ?? 0) + 1;
        labelCounts.set(baseLabel, count);
        const label = count === 1 ? baseLabel : `${baseLabel}_${count}`;

        redactions.push({
          file: file.path,
          label,
          matched: match,
          hint: pattern.hint,
          pattern: pattern.name,
        });
        if (!seenLabels.has(label)) {
          seenLabels.add(label);
          placeholders.push({ label, hint: pattern.hint });
        }
        dirty = true;
        return `{{NEEDS_FROM_USER:${label}}}`;
      });
    }

    if (dirty) {
      scrubbed.set(file.path, content);
    }
  }

  return { scrubbed, redactions, placeholders };
}

/**
 * Apply a placeholder substitution map back to a previously-scrubbed
 * file. Used on the import side once Yoshi has collected values from
 * the user.
 */
export function applyPlaceholders(content: string, values: Record<string, string>): string {
  return content.replace(/\{\{NEEDS_FROM_USER:([A-Z0-9_]+)\}\}/g, (_match, label: string) => {
    return Object.prototype.hasOwnProperty.call(values, label) ? values[label] : `{{NEEDS_FROM_USER:${label}}}`;
  });
}

/**
 * Scan a single string for any remaining placeholders. Useful for
 * detecting "still needs setup" state.
 */
export function findPlaceholders(content: string): string[] {
  const labels = new Set<string>();
  for (const m of content.matchAll(/\{\{NEEDS_FROM_USER:([A-Z0-9_]+)\}\}/g)) {
    labels.add(m[1]);
  }
  return Array.from(labels);
}
