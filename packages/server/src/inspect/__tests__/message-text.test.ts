// v3.5 inspect B1 — a stored message's content as a person reads it, pinned.
//
// messageText turns a plain cell or a JSON block array into text: a text block is its text, a
// tool_use reads "calls <tool> <input>", a tool_result "<tool> (ok|error): <text>" with the name
// from the call (collected with toolNamesIn). A cell that merely STARTS WITH "[" is still text,
// never read as blocks. failedResults returns only the is_error results, as {tool, text}.
// Pure: no database, no network.

import { describe, it, expect } from 'vitest';
import { messageText, toolNamesIn, failedResults } from '../message-text.js';

// A text line, a call, and the result that answers it.
const CALL = [
  { type: 'text', text: 'a' },
  { type: 'tool_use', id: 't1', name: 'foo', input: { x: 1 } },
  { type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'bad' },
];

describe('messageText', () => {
  it('returns plain text unchanged', () => {
    expect(messageText('plain')).toBe('plain');
  });

  it('renders a text line, a call, and a result whose name comes from the call', () => {
    expect(messageText(JSON.stringify(CALL), new Map([['t1', 'foo']]))).toBe('a\ncalls foo {"x":1}\nfoo (error): bad');
  });

  it('an empty names map: the result line reads "tool (error):", the other lines untouched', () => {
    expect(messageText(JSON.stringify(CALL), new Map())).toBe('a\ncalls foo {"x":1}\ntool (error): bad');
  });

  it('a result that did not flag is_error reads (ok)', () => {
    expect(messageText(JSON.stringify([{ type: 'tool_result', tool_use_id: 't1', content: 'ok text' }]), new Map([['t1', 'foo']]))).toBe('foo (ok): ok text');
  });

  it('joins the texts of a block-array result by newlines', () => {
    const content = JSON.stringify([{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] }]);
    expect(messageText(content, new Map([['t1', 'foo']]))).toBe('foo (ok): first\nsecond');
  });

  it('renders an unknown block type as [type]', () => {
    expect(messageText(JSON.stringify([{ type: 'image' }]))).toBe('[image]');
  });

  it('leaves text that starts with "[" but is not a block array alone', () => {
    expect(messageText('[not json')).toBe('[not json');
    expect(messageText('[1,2,3]')).toBe('[1,2,3]');
    expect(messageText('[{"a":1}]')).toBe('[{"a":1}]');
  });
});

describe('toolNamesIn', () => {
  it('maps each call id to its name and ignores a plain row', () => {
    expect(toolNamesIn([JSON.stringify([{ type: 'tool_use', id: 't1', name: 'foo' }]), 'x'])).toEqual(new Map([['t1', 'foo']]));
  });

  it('a repeated id: the later row wins', () => {
    expect(toolNamesIn([JSON.stringify([{ type: 'tool_use', id: 't1', name: 'foo' }]), JSON.stringify([{ type: 'tool_use', id: 't1', name: 'bar' }])]).get('t1')).toBe('bar');
  });
});

describe('failedResults', () => {
  it('returns only the is_error results, as {tool, text}', () => {
    const content = JSON.stringify([
      { type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'bad' },
      { type: 'tool_result', tool_use_id: 't2', content: 'good' },
    ]);
    expect(failedResults(content, new Map([['t1', 'foo']]))).toEqual([{ tool: 'foo', text: 'bad' }]);
  });

  it('is empty for plain text', () => {
    expect(failedResults('plain')).toEqual([]);
  });
});
