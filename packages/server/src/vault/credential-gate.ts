// ════════════════════════════════════════
// THE VAULT'S CREDENTIAL GATE — a safety gate (the spec's Group C): deterministic, no model, ever.
//
// Moved byte-for-byte out of `vault/tools.ts` (v3.5 C3/C4) so the file that asks the decision model about
// memory shape (`shape-judgment.ts`, called from `tools.ts`) and the file that keeps secrets out of the vault
// are not one file: this module imports nothing, and the census
// (`agent/__tests__/decide-never-touches-a-safety-gate.test.ts`) pins that it never will. A decision model
// could be an EXTRA net here, never the replacement: injected content in an entry can shift its answers.
// ════════════════════════════════════════

// Credential-shaped content must not enter the vault. Credentials live in
// the separate encrypted store (agent_credentials table, accessed via
// credential_add/get/update/delete). Vault entries can decay, appear in
// vault_search, and are visible to the Dreamer for summarization, none
// of which is appropriate for API keys, tokens, or passwords.
//
// Detection is high-precision (known token prefixes + key/value with
// credential-named keys and substantive values). A false positive here is
// cheap (the agent re-routes to credential_add); a false negative would
// silently leak a secret into the vault.
const CREDENTIAL_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'GitHub PAT', re: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { name: 'GitHub OAuth token', re: /\bgh[osu]_[A-Za-z0-9]{20,}\b/ },
  { name: 'Shopify access token', re: /\bshp(?:pa|at|ca|ss)_[A-Za-z0-9]{16,}\b/ },
  { name: 'Stripe key', re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'OpenAI key', re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/ },
  { name: 'Slack token', re: /\bxox[bpars]-[A-Za-z0-9-]{20,}\b/ },
  { name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35,}\b/ },
  { name: 'PEM private key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  // Credential-shaped key/value pairs. Requires an explicit credential-named
  // key, an assignment operator (: or =), and a non-trivial value (>=8 chars).
  // Conservative enough to allow notes like "the user has a github account"
  // while catching "api_key: shppa_FAKE_a1b2c3d4e5f6".
  {
    name: 'credential-shaped key/value',
    re: /\b(?:api[_-]?key|api[_-]?secret|access[_-]?key|secret[_-]?key|client[_-]?secret|private[_-]?key|auth[_-]?token|bearer[_-]?token|refresh[_-]?token|access[_-]?token|session[_-]?token|secret|password|passwd|pwd)\s*[:=]\s*['"]?[A-Za-z0-9_+/=.~!@#$%^&*-]{8,}/i,
  },
];

export function detectCredentialContent(content: string): string | null {
  for (const { name, re } of CREDENTIAL_PATTERNS) {
    if (re.test(content)) return name;
  }
  return null;
}
