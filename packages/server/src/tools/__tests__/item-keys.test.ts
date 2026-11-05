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

// v3.5 field fix 3 (#6a): the worker's file and command work, from the tool's own declared effects.
describe('itemKeysOf: files and commands, from declared effects', () => {
  it('fs_write and fs_delete name a file; proc (argv) and shell (script) name a command; reads name nothing', () => {
    expect(itemKeysOf('file_write', { path: '/w/a.md' }, [{ kind: 'fs_write', from: 'args.path' }])).toEqual(['file:/w/a.md']);
    expect(itemKeysOf('file_patch', { path: '/w/a.md' }, [{ kind: 'fs_read', from: 'args.path' }, { kind: 'fs_write', from: 'args.path' }])).toEqual(['file:/w/a.md']);
    expect(itemKeysOf('exec', { argv: ['mkdir', '-p', '/w'] }, [{ kind: 'proc', from: 'args.argv' }])).toEqual(['cmd:mkdir -p /w']);
    expect(itemKeysOf('shell', { script: 'ls /w | wc -l' }, [{ kind: 'shell', from: 'args.script' }])).toEqual(['cmd:ls /w | wc -l']);
    expect(itemKeysOf('file_read', { path: '/w/a.md' }, [{ kind: 'fs_read', from: 'args.path' }])).toEqual([]);
  });
  it('an array argument names each element; a derived effect, a blank or a non-string names nothing', () => {
    expect(itemKeysOf('t', { out: { paths: ['/a', '', 3, '/b'] } }, [{ kind: 'fs_write', from: 'args.out.paths[]' }])).toEqual(['file:/a', 'file:/b']);
    expect(itemKeysOf('t', {}, [{ kind: 'proc', from: 'derived:a helper process' }])).toEqual([]);
    expect(itemKeysOf('exec', { argv: [] }, [{ kind: 'proc', from: 'args.argv' }])).toEqual([]);
  });
  it('mailbox keys and effect keys add up; nothing changes for a call without effects', () => {
    expect(itemKeysOf('gmail_label', { message_id: 'm1' }, [{ kind: 'fs_write', from: 'args.save_to' }])).toEqual(['gmail:msg:m1']);
    expect(itemKeysOf('gmail_label', { message_id: 'm1', save_to: '/w/m1.eml' }, [{ kind: 'fs_write', from: 'args.save_to' }])).toEqual(['gmail:msg:m1', 'file:/w/m1.eml']);
  });
});
