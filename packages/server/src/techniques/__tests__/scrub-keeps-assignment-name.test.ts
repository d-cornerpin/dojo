// The scrubber must replace only the secret value, not the surrounding
// assignment syntax. `export GITHUB_TOKEN="<value>"` must keep the name, the
// `=` and the quotes; a `Bearer <value>` header must keep the word Bearer.

import { describe, it, expect } from 'vitest';
import { scrubFiles } from '../scrub.js';

function scrubOne(content: string) {
  return scrubFiles([{ path: 'a.md', content }]);
}

describe('scrub keeps the assignment name', () => {
  it('keeps `export GITHUB_TOKEN=` and the quotes around the value', () => {
    const { scrubbed } = scrubOne(`export GITHUB_TOKEN="${'a'.repeat(20)}"`);
    expect(scrubbed.get('a.md')).toBe(`export GITHUB_TOKEN="{{NEEDS_FROM_USER:GITHUB_TOKEN}}"`);
  });

  it('keeps `Bearer ` before the bearer token value', () => {
    const { scrubbed } = scrubOne(`curl -H "Authorization: Bearer ${'b'.repeat(24)}" x`);
    expect(scrubbed.get('a.md')).toBe(`curl -H "Authorization: Bearer {{NEEDS_FROM_USER:BEARER_TOKEN}}" x`);
  });

  it('keeps `DB_PASSWORD=` before the assigned value', () => {
    const { scrubbed } = scrubOne(`DB_PASSWORD=${'c'.repeat(18)}`);
    expect(scrubbed.get('a.md')).toBe(`DB_PASSWORD={{NEEDS_FROM_USER:DB_PASSWORD}}`);
  });

  it('guards: a key-shaped value wins first and keeps its name', () => {
    const { scrubbed } = scrubOne(`OPENAI_API_KEY=sk-${'d'.repeat(22)}`);
    expect(scrubbed.get('a.md')).toBe(`OPENAI_API_KEY={{NEEDS_FROM_USER:OPENAI_API_KEY}}`);
  });

  it('guards: a documented placeholder value is untouched', () => {
    const { scrubbed } = scrubOne(`API_KEY=<your-key-here>`);
    expect(scrubbed.get('a.md')).toBeUndefined();
  });

  it('records the full matched text and pattern for an env assignment', () => {
    const { scrubbed, redactions } = scrubOne(`DB_PASSWORD=${'c'.repeat(18)}`);
    expect(scrubbed.get('a.md')).toBe(`DB_PASSWORD={{NEEDS_FROM_USER:DB_PASSWORD}}`);
    expect(redactions[0].matched).toBe(`DB_PASSWORD=${'c'.repeat(18)}`);
    expect(redactions[0].pattern).toBe('env-secret-assignment');
  });
});
