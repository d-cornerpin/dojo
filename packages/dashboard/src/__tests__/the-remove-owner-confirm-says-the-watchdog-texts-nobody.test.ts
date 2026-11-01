import { describe, it, expect, vi } from 'vitest';
import { confirmRemoveOwner } from '../lib/owner-star';

describe('removing the owner from a sender list', () => {
  it('the confirm says that with no owner marked the watchdog will text nobody', () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('window', { confirm });
    confirmRemoveOwner('Pat');
    const text = String((confirm.mock.calls[0] as unknown as string[])[0]);
    expect(text).toMatch(/no owner/i);
    expect(text).toMatch(/watchdog will text nobody/i);
    vi.unstubAllGlobals();
  });
});
