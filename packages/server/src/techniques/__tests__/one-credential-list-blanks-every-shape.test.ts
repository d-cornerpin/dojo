// One list of credential shapes serves the technique exporter and every dojo_inspect view, so every shape either use
// knew is blanked by both: the secret never survives a scrubbed technique file or an inspect line.
import { describe, it, expect } from 'vitest';
import { scrubFiles } from '../scrub.js';
import { redactText } from '../../inspect/redact.js';

const r = (n: number, c = 'a1'): string => c.repeat(n);
/** [the text, the secret it carries]: shapes the exporter knew, then shapes the inspect view knew. */
const SHAPES: Array<[string, string]> = [
  [`key sk-ant-${r(12)}`, `sk-ant-${r(12)}`],
  [`key sk-proj-${r(12)}`, `sk-proj-${r(12)}`],
  [`token ghp_${r(18)}`, `ghp_${r(18)}`],
  [`token hf_${r(18)}`, `hf_${r(18)}`],
  [`slack xoxb-${r(12)}`, `xoxb-${r(12)}`],
  [`aws AKIA${'B'.repeat(16)}`, `AKIA${'B'.repeat(16)}`],
  [`stripe sk_live_${r(12)}`, `sk_live_${r(12)}`],
  [`jwt eyJ${r(6)}.eyJ${r(6)}.${r(6)}`, `eyJ${r(6)}.eyJ${r(6)}.${r(6)}`],
  ['db postgres://user:Pa55word9x@db.example.com/x', 'Pa55word9x'],
  [`Authorization: Bearer ${r(12)}+/=${r(4)}`, `${r(12)}+/=${r(4)}`],
  [`FOO_SECRET="${r(8)}"`, r(8)],
  [`-----BEGIN PRIVATE KEY-----\n${r(20)}\n-----END PRIVATE KEY-----`, r(20)],
  [`google ya29.${r(8)}`, `ya29.${r(8)}`],
  [`github github_pat_${r(12)}`, `github_pat_${r(12)}`],
  [`AIza${r(18)}`, `AIza${r(18)}`],
  [`client GOCSPX-${r(8)}`, `GOCSPX-${r(8)}`],
  [`Cookie: session=${r(10)}`, `session=${r(10)}`],
  [`run --api-key=${r(10)}`, r(10)],
  [`sshpass -p S3cretPass9 ssh host`, 'S3cretPass9'],
  [`<password>${r(8)}</password>`, r(8)],
  [`https://example.com/x?access_key=${r(10)}`, r(10)],
];

describe('one credential list', () => {
  for (const [text, secret] of SHAPES) {
    it(`blanks ${secret.slice(0, 12)}... in an exported technique and in an inspect view`, () => {
      const out = scrubFiles([{ path: 'a.md', content: text }]).scrubbed.get('a.md') ?? text;
      expect(out, 'exporter').not.toContain(secret);
      expect(redactText(text), 'inspect').not.toContain(secret);
    });
  }
});

describe('the exporter places each placeholder once', () => {
  it('a URL with a user, a password and a host becomes one placeholder, and the manifest names only that one', () => {
    const { scrubbed, placeholders } = scrubFiles([{ path: 'a.md', content: 'db postgres://admin:s3cretPw9@db.example.com/x' }]);
    expect(scrubbed.get('a.md')).toBe('db {{NEEDS_FROM_USER:SERVICE_URL_WITH_CREDENTIALS}}/x');
    expect(placeholders.map((p) => p.label)).toEqual(['SERVICE_URL_WITH_CREDENTIALS']);
  });
});
