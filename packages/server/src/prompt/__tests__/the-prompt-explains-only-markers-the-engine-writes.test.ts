// The always-on prompt explains engine prefixes. It must name only the ones the engine actually
// writes: nothing writes `[ENGINE RENAME REQUEST]` or `[Engine ack]`, so the prompt must not name them.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../config/platform.js', async (orig) => ({ ...(await orig<typeof import('../../config/platform.js')>()), getOwnerName: () => 'the owner' }));

import { renderPrecedenceLadder, renderMessageSources } from '../assembler.js';

describe('the prompt explains only markers the engine writes', () => {
  it('the ladder names no marker nothing writes', () => {
    const ladder = renderPrecedenceLadder();
    expect(ladder).not.toContain('[ENGINE RENAME REQUEST]');
    expect(ladder).not.toContain('[Engine ack]');
    expect(ladder).toContain('[Engine note: ...]');
    expect(ladder).toContain('[Engine hint: ...]');
  });

  it('the message sources name no marker nothing writes', () => {
    const sources = renderMessageSources();
    expect(sources).not.toContain('[ENGINE RENAME REQUEST]');
    expect(sources).not.toContain('[Engine ack]');
    expect(sources).toContain('defined ONCE in the Instruction Precedence section above');
  });
});
