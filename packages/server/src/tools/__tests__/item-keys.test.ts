// v3.5 DONE IS MEASURED, Task A3 — which tool calls touch which items (the ledger's keys).
import { describe, it, expect } from 'vitest';
import { itemKeysOf } from '../item-keys.js';

describe('itemKeysOf', () => {
  it('gmail_label: one message, one thread, and the batch forms', () => {
    expect(itemKeysOf('gmail_label', { message_id: 'm1' })).toEqual(['gmail:msg:m1']);
    expect(itemKeysOf('gmail_label', { thread_id: 't1' })).toEqual(['gmail:thread:t1']);
    expect(itemKeysOf('gmail_label', { message_ids: ['m1', 'm2', 'm1'] })).toEqual(['gmail:msg:m1', 'gmail:msg:m2']);
    expect(itemKeysOf('user_gmail_label', { thread_ids: ['t1'] })).toEqual(['gmail:thread:t1']);
  });
  it('outlook per-message mutations: the message', () => {
    expect(itemKeysOf('outlook_move_to_folder', { message_id: 'o1' })).toEqual(['outlook:msg:o1']);
    expect(itemKeysOf('user_outlook_move_to_folder', { message_id: 'o1' })).toEqual(['outlook:msg:o1']);
    expect(itemKeysOf('outlook_mark_read', { message_id: 'o2' })).toEqual(['outlook:msg:o2']);
    expect(itemKeysOf('outlook_delete', { message_id: 'o3' })).toEqual(['outlook:msg:o3']);
    expect(itemKeysOf('outlook_categories_set', { message_id: 'o4', categories: [] })).toEqual(['outlook:msg:o4']);
  });
  it('a read or a tool with no item touches nothing', () => {
    expect(itemKeysOf('gmail_search', { query: 'x' })).toEqual([]);
    expect(itemKeysOf('gmail_read', { message_id: 'm1' })).toEqual([]);
    expect(itemKeysOf('get_current_time', {})).toEqual([]);
  });
  it('garbage ids are not items', () => {
    expect(itemKeysOf('gmail_label', { message_id: '', message_ids: [3, null, 'm9'] })).toEqual(['gmail:msg:m9']);
    expect(itemKeysOf('gmail_label', {})).toEqual([]);
  });
});
