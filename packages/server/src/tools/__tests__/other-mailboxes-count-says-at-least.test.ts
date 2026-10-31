import { describe, it, expect } from 'vitest';
import { renderOtherMailboxesCount, type UnifiedSource } from '../unified-read.js';

const src: UnifiedSource = { providerLabel: 'Gmail', slot: 'owner', email: 'o@ex.test', labelKey: 'owner Gmail' };

describe('other-mailbox count wording', () => {
  it('prints N+ when the count hit the page limit', () => {
    expect(renderOtherMailboxesCount([{ source: src, count: 5, atLeast: true }], new Set())).toContain('5+ in');
  });
  it('prints an exact count below the limit', () => {
    const out = renderOtherMailboxesCount([{ source: src, count: 2 }], new Set());
    expect(out).toContain('2 in');
    expect(out).not.toContain('2+');
  });
});
