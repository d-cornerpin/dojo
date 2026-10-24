import { describe, it, expect } from 'vitest';
import { classifyTool } from '@dojo/shared';

// A mailbox job (label / archive / trash / mark) is real work: the engine reads this class
// to decide whether a turn made progress. These verbs used to fall through to "bookkeeping".
describe('mutation verbs are effectful', () => {
  it.each([
    'gmail_label',
    'user_gmail_label',
    'outlook_move_to_folder',
    'outlook_mark_read',
    'gmail_archive',
    'gmail_trash',
    'gmail_untrash',
    'gmail_star',
    'gmail_batch_modify',
  ])('%s -> effectful-action', (n) => {
    expect(classifyTool(n)).toBe('effectful-action');
  });

  it.each(['gmail_list_labels', 'gmail_search', 'gmail_read', 'outlook_search'])(
    '%s stays retrieval',
    (n) => {
      expect(classifyTool(n)).toBe('retrieval');
    },
  );
});
