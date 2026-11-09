// C12 (R24): a confirmed owner email counts as the owner speaking, including his approvals ("yes <id>"): its words
// reach the same command/approval handler a text reaches. The watchers append `ownerEmailCommandNote` to the notice.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveHealerProposal = vi.fn(() => ({ ok: true }));
vi.mock('../../gateway/routes/healer.js', () => ({ resolveHealerProposal: (...a: unknown[]) => (resolveHealerProposal as (...x: unknown[]) => unknown)(...a) }));
vi.mock('../../db/connection.js', () => ({
  getDb: () => ({ prepare: () => ({ all: () => [{ id: 'abc12345-0000' }], get: () => undefined, run: () => ({ changes: 0 }) }) }),
  closeDb: vi.fn(), getDbPath: () => ':memory:',
}));

import { ownerEmailCommandNote } from '../mail-owner-intake.js';

beforeEach(() => resolveHealerProposal.mockClear());

describe('C12 — a confirmed owner email runs his approvals like a text', () => {
  it('"yes <id>" in a confirmed owner email approves the pending proposal and tells the agent', async () => {
    const note = await ownerEmailCommandNote({ state: 'confirmed', words: 'Yes abc123' });
    expect(resolveHealerProposal).toHaveBeenCalledWith({ id: 'abc12345-0000', action: 'approve', note: null });
    expect(note).toMatch(/Approved/);
    expect(note).toMatch(/Tell the owner in your own words/);
  });

  it('"no <id>" denies it', async () => {
    await ownerEmailCommandNote({ state: 'confirmed', words: 'no abc123' });
    expect(resolveHealerProposal).toHaveBeenCalledWith({ id: 'abc12345-0000', action: 'deny', note: null });
  });

  it('ordinary words are no command: nothing runs, no note', async () => {
    expect(await ownerEmailCommandNote({ state: 'confirmed', words: 'Please close the ticket, thanks' })).toBe('');
    expect(resolveHealerProposal).not.toHaveBeenCalled();
  });

  it('an unconfirmed owner address never runs anything', async () => {
    expect(await ownerEmailCommandNote({ state: 'unconfirmed', reason: 'check_failed' })).toBe('');
    expect(await ownerEmailCommandNote({ state: 'none' })).toBe('');
    expect(resolveHealerProposal).not.toHaveBeenCalled();
  });
});

describe('C12 — only the first non-empty line is matched', () => {
  it('"yes <id>" followed by a signature still approves', async () => {
    const note = await ownerEmailCommandNote({ state: 'confirmed', words: '\n\nyes abc123\n\nSent from my iPhone' });
    expect(resolveHealerProposal).toHaveBeenCalledWith({ id: 'abc12345-0000', action: 'approve', note: null });
    expect(note).toMatch(/Approved/);
  });
  it('a first line that is not a command runs nothing, even if a later line is one', async () => {
    expect(await ownerEmailCommandNote({ state: 'confirmed', words: 'Thanks for this\nyes abc123' })).toBe('');
    expect(resolveHealerProposal).not.toHaveBeenCalled();
  });
  it('an unconfirmed email with the same words never runs', async () => {
    expect(await ownerEmailCommandNote({ state: 'unconfirmed', reason: 'bcc' })).toBe('');
    expect(resolveHealerProposal).not.toHaveBeenCalled();
  });
});
