// When a technique is exported, a key that appears in two files (or twice in one file) becomes one
// placeholder, so the person importing it is asked for it once. Two different keys still get two.

import { describe, it, expect } from 'vitest';
import { scrubFiles } from '../scrub.js';

const SAME = 'ghp_' + 'f'.repeat(32);
const OTHER = 'ghp_' + 'g'.repeat(32);

describe('one secret in two files', () => {
  it('becomes one placeholder used in both files', () => {
    const { scrubbed, placeholders } = scrubFiles([
      { path: 'run.sh', content: `curl -H "token ${SAME}" example.com` },
      { path: 'README.md', content: `Token: ${SAME} and again ${SAME}` },
    ]);
    expect(placeholders.map((p) => p.label)).toEqual(['GITHUB_TOKEN']);
    expect(scrubbed.get('run.sh')).toBe('curl -H "token {{NEEDS_FROM_USER:GITHUB_TOKEN}}" example.com');
    expect(scrubbed.get('README.md')).toBe('Token: {{NEEDS_FROM_USER:GITHUB_TOKEN}} and again {{NEEDS_FROM_USER:GITHUB_TOKEN}}');
  });

  it('two different keys still get two placeholders', () => {
    const { placeholders } = scrubFiles([
      { path: 'a.sh', content: `${SAME}` },
      { path: 'b.sh', content: `${OTHER}` },
    ]);
    expect(placeholders.map((p) => p.label)).toEqual(['GITHUB_TOKEN', 'GITHUB_TOKEN_2']);
  });
});
