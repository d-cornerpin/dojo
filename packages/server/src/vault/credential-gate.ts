// Deterministic, never a model (decide-never-touches-a-safety-gate.test.ts pins that no import reaches the
// decision code); a model could be an extra net, never the replacement: injected entry content can steer it.

// Credentials live in the encrypted store, never the vault. A false positive only re-routes the agent to
// credential_add; a false negative would leak a secret into the vault.
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
