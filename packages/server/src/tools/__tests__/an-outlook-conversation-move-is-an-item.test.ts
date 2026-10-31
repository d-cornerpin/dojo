// v3.5 DONE IS MEASURED — moving a WHOLE Outlook conversation is an item on the ledger, not nothing.
import { describe, it, expect } from 'vitest';
import { itemKeysOf } from '../item-keys.js';

describe('itemKeysOf: an Outlook conversation move is an item', () => {
  it('outlook_move_to_folder: a conversation-only move touches the conversation', () => {
    expect(itemKeysOf('outlook_move_to_folder', { conversation_id: 'c1', folder_id: 'archive' })).toEqual(['outlook:conv:c1']);
  });
  it('outlook_move_to_folder: the user_ form touches the conversation too', () => {
    expect(itemKeysOf('user_outlook_move_to_folder', { conversation_id: 'c1', folder_id: 'archive' })).toEqual(['outlook:conv:c1']);
  });
  it('outlook_move_to_folder: the message keys first, then the conversation key', () => {
    expect(itemKeysOf('outlook_move_to_folder', { message_id: 'o1', conversation_id: 'c1', folder_id: 'archive' })).toEqual(['outlook:msg:o1', 'outlook:conv:c1']);
  });
  it('only the move tool reads a conversation', () => {
    expect(itemKeysOf('outlook_mark_read', { message_id: 'o2', conversation_id: 'c1' })).toEqual(['outlook:msg:o2']);
  });
  it('an empty conversation_id is not an item', () => {
    expect(itemKeysOf('outlook_move_to_folder', { conversation_id: '', folder_id: 'archive' })).toEqual([]);
  });
});
