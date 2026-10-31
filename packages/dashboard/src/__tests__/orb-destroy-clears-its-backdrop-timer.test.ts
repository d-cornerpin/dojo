import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The orb engine cannot be built without a GPU, so this reads the source.
const src = readFileSync(join(__dirname, '../components/orb/dojoOrbEngine.ts'), 'utf8');

describe('orb destroy and the backdrop timer', () => {
  it('destroy() cancels a pending backdrop repaint', () => {
    const start = src.indexOf('function destroy(): void');
    const body = src.slice(start, start + 1500);
    expect(body).toContain('clearTimeout(backdropTimer)');
  });
  it('makeBackdrop() does nothing once the orb is destroyed', () => {
    const start = src.indexOf('function makeBackdrop(): void {');
    expect(src.slice(start, start + 200)).toContain('if (destroyed) return;');
  });
});
