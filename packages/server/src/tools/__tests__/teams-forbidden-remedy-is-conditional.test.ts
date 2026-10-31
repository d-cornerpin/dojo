import { describe, it, expect } from 'vitest';
import { remedyNote } from '../error-remedies.js';

const denied = 'Access denied (HTTP 403 Forbidden).';

describe('Teams 403 remedy', () => {
  it('names personal accounts as one possible cause, not the only one', () => {
    const note = remedyNote('teams_list_chats', denied);
    expect(note).toContain('work/school account');
    expect(note).toContain('If this IS a work/school account');
  });
  it('does not apply to other tools', () => {
    expect(remedyNote('gmail_send', denied)).toBe('');
  });
});
