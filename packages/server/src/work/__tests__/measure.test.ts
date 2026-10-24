// v3.5 DONE IS MEASURED, Task A2 — the Measure type: what the engine can replay and count.
import { describe, it, expect } from 'vitest';
import { parseMeasure, describeMeasure } from '../measure.js';

describe('parseMeasure', () => {
  it('accepts a gmail_search measure', () => {
    const r = parseMeasure({ tool: 'gmail_search', args: { query: 'in:inbox -label:Done' }, unit: 'messages' });
    expect(r).toEqual({ ok: true, measure: { tool: 'gmail_search', args: { query: 'in:inbox -label:Done' }, unit: 'messages' } });
  });
  it('accepts the user-mailbox form, keeps the account, and defaults the unit', () => {
    const r = parseMeasure({ tool: 'user_gmail_search', args: { query: '  in:inbox  ', account: 'acct-1' } });
    expect(r).toEqual({ ok: true, measure: { tool: 'user_gmail_search', args: { query: 'in:inbox', account: 'acct-1' }, unit: 'items' } });
  });
  it('refuses an unknown tool and an empty query, naming the fault', () => {
    expect(parseMeasure({ tool: 'gmail_send', args: { query: 'x' } })).toMatchObject({ ok: false, error: expect.stringContaining('gmail_send') });
    expect(parseMeasure({ tool: 'gmail_send', args: { query: 'x' } })).toMatchObject({ ok: false, error: expect.stringContaining('cannot be counted') });
    expect(parseMeasure({ tool: 'gmail_search', args: { query: '' } })).toMatchObject({ ok: false, error: expect.stringContaining('query') });
    expect(parseMeasure('in:inbox')).toMatchObject({ ok: false });
    expect(parseMeasure(null)).toMatchObject({ ok: false });
  });
  it('an inherited object key is not a counter', () => {
    expect(parseMeasure({ tool: 'toString', args: { query: 'x' } })).toMatchObject({ ok: false, error: expect.stringContaining('toString') });
  });
  it('describes itself in one line without the account', () => {
    expect(describeMeasure({ tool: 'gmail_search', args: { query: 'in:inbox', account: 'acct-1' }, unit: 'messages' })).toBe('gmail_search "in:inbox"');
  });
});
