// t14 — the deterministic technique secret scrubber, pinned.
//
// A scrubber that silently stops catching a key shape is a leak, so every
// recognised shape and the placeholder round-trip are pinned here. All fake
// secrets below are built from repeated characters — none is a real key.
//
// These are pinning tests, not a failing-first fix: they assert the scrubber's
// current behaviour and must pass against the unchanged scrub.ts.

import { describe, it, expect } from 'vitest';
import { scrubFiles, isBinaryFile } from '../scrub.js';

// Scrub a single file and return its redacted content (undefined when the file
// was binary or clean, and so left out of the result map).
function scrubOne(path: string, content: string): string | undefined {
  return scrubFiles([{ path, content }]).scrubbed.get(path);
}

describe('scrubFiles — a recognised shape becomes a placeholder', () => {
  // Three shapes in one file, one each: the scrubbed content, the ordered
  // pattern names that fired, and the de-duped placeholder list.
  it('replaces an anthropic key, a github token and an env assignment', () => {
    const anthropic = 'sk-ant-' + 'a'.repeat(25);
    const github = 'ghp_' + 'b'.repeat(32);
    const envValue = 'abcdefghijklmnop';
    const content = `key ${anthropic} and ${github} API_TOKEN=${envValue}`;

    const { scrubbed, redactions, placeholders } = scrubFiles([{ path: 'a.md', content }]);

    expect(scrubbed.get('a.md')).toBe(
      'key {{NEEDS_FROM_USER:ANTHROPIC_API_KEY}} and ' +
        '{{NEEDS_FROM_USER:GITHUB_TOKEN}} API_TOKEN={{NEEDS_FROM_USER:API_TOKEN}}',
    );
    expect(redactions.map((r) => r.pattern)).toEqual([
      'anthropic-key',
      'github-token',
      'env-secret-assignment',
    ]);
    expect(placeholders.map((p) => p.label)).toEqual([
      'ANTHROPIC_API_KEY',
      'GITHUB_TOKEN',
      'API_TOKEN',
    ]);
    // The de-duped list is safe to export: no entry carries a secret value,
    // only a label and a fixed hint.
    for (const p of placeholders) {
      const text = p.label + p.hint;
      expect(text).not.toContain(anthropic);
      expect(text).not.toContain(github);
      expect(text).not.toContain(envValue);
    }
  });

  // A binary file is skipped even when its content holds a key; a clean file is
  // left out of the result map entirely, and nothing was redacted.
  it('skips binary files and omits clean files from the result', () => {
    const { scrubbed, redactions } = scrubFiles([
      { path: 'pic.png', content: 'sk-ant-' + 'a'.repeat(25) },
      { path: 'notes.txt', content: 'just some harmless notes' },
    ]);
    expect(scrubbed.has('pic.png')).toBe(false);
    expect(scrubbed.has('notes.txt')).toBe(false);
    expect(redactions).toHaveLength(0);
  });

  // A repeated label gets a numeric suffix, and the counter is shared across
  // the files of one scrub pass, so the second file continues the count.
  it('numbers repeated labels and continues the count across files', () => {
    const { scrubbed } = scrubFiles([
      { path: 'a.txt', content: 'ghp_' + 'c'.repeat(32) + ' ' + 'ghp_' + 'd'.repeat(32) },
      { path: 'b.txt', content: 'ghp_' + 'e'.repeat(32) },
    ]);
    expect(scrubbed.get('a.txt')).toBe(
      '{{NEEDS_FROM_USER:GITHUB_TOKEN}} {{NEEDS_FROM_USER:GITHUB_TOKEN_2}}',
    );
    expect(scrubbed.get('b.txt')).toBe('{{NEEDS_FROM_USER:GITHUB_TOKEN_3}}');
  });
});

describe('scrubFiles — every remaining PATTERNS entry', () => {
  // One entry per remaining pattern. `expected` overrides the default
  // `{{NEEDS_FROM_USER:<label>}}` where the match leaves a trailing fragment —
  // the url-creds regex stops at the path separator, so the path stays.
  type PatternCase = { name: string; secret: string; label: string; expected?: string };
  const cases: PatternCase[] = [
    { name: 'openai-key', secret: 'sk-' + 'a'.repeat(24), label: 'OPENAI_API_KEY' },
    { name: 'github-oauth', secret: 'gho_' + 'a'.repeat(30), label: 'GITHUB_OAUTH_TOKEN' },
    { name: 'github-app', secret: 'ghu_' + 'a'.repeat(30), label: 'GITHUB_APP_TOKEN' },
    { name: 'huggingface-key', secret: 'hf_' + 'a'.repeat(30), label: 'HUGGINGFACE_TOKEN' },
    { name: 'slack-bot', secret: 'xoxb-' + 'a'.repeat(20), label: 'SLACK_TOKEN' },
    { name: 'aws-access-key', secret: 'AKIA' + 'A'.repeat(16), label: 'AWS_ACCESS_KEY_ID' },
    { name: 'google-api-key', secret: 'AIza' + 'a'.repeat(35), label: 'GOOGLE_API_KEY' },
    { name: 'stripe-key (secret)', secret: 'sk_live_' + 'a'.repeat(20), label: 'STRIPE_SECRET_KEY' },
    { name: 'stripe-key (publishable)', secret: 'pk_live_' + 'b'.repeat(20), label: 'STRIPE_PUBLISHABLE_KEY' },
    { name: 'jwt', secret: 'eyJ' + 'a'.repeat(12) + '.' + 'b'.repeat(12) + '.' + 'c'.repeat(12), label: 'JWT_TOKEN' },
    {
      name: 'url-creds',
      secret: 'postgres://user:pass@host/db',
      label: 'SERVICE_URL_WITH_CREDENTIALS',
      expected: '{{NEEDS_FROM_USER:SERVICE_URL_WITH_CREDENTIALS}}/db',
    },
    { name: 'bearer-header', secret: 'Bearer ' + 'a'.repeat(24), label: 'BEARER_TOKEN', expected: 'Bearer {{NEEDS_FROM_USER:BEARER_TOKEN}}' },
  ];

  for (const c of cases) {
    it(c.name + ' is replaced by a placeholder', () => {
      const scrubbed = scrubOne('f.txt', c.secret)!;
      expect(scrubbed).toBe(c.expected ?? `{{NEEDS_FROM_USER:${c.label}}}`);
      // The raw secret value never survives in the scrubbed content.
      expect(scrubbed).not.toContain(c.secret);
    });
  }
});

describe('isBinaryFile — keys on the case-insensitive extension', () => {
  it('matches a binary extension regardless of case', () => {
    expect(isBinaryFile('x.PNG')).toBe(true);
  });
  it('is false for a path with no extension', () => {
    expect(isBinaryFile('x')).toBe(false);
  });
  it('is false for a non-binary extension even with nested dirs', () => {
    expect(isBinaryFile('a.b/c')).toBe(false);
  });
});
