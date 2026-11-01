import { describe, it, expect } from 'vitest';
import { skippedLinksMessage } from '../components/TechniqueCard';

describe('the export toast names the links it left out', () => {
  it('names one link', () => {
    expect(skippedLinksMessage(['notes/peek.txt'])).toContain('notes/peek.txt');
    expect(skippedLinksMessage(['notes/peek.txt'])).toContain('1 link was');
  });
  it('counts the rest when there are many', () => {
    const m = skippedLinksMessage(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(m).toContain('7 links were');
    expect(m).toContain('and 2 more');
  });
});
