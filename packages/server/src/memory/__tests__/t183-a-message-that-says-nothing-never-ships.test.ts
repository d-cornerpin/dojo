// t183 (Run 17 S2 attempt 2): an EMPTY assistant row merged into the next assistant row as an empty text block,
// the shape validator refused, and the owner's conversation was quarantined. Messages and blocks that say
// nothing are dropped before the role merge.
import { describe, it, expect } from 'vitest';
import { dropEmptyMessages } from '../drop-empty.js';

describe('t183: a message that says nothing never ships', () => {
  it('the measured shape: an empty assistant string beside a tool_use row is dropped, the tool_use kept', () => {
    const out = dropEmptyMessages([
      { role: 'user', content: 'Track the receipts.' },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'work_update', input: {} }] },
    ]);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(JSON.stringify(out)).not.toContain('"text":""');
  });
  it('blank text blocks are removed from a structured message; a message left with nothing is dropped', () => {
    const out = dropEmptyMessages([
      { role: 'assistant', content: [{ type: 'text', text: '  ' }, { type: 'tool_use', id: 't2', name: 'x', input: {} }] },
      { role: 'assistant', content: [{ type: 'text', text: '' }] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toEqual([{ type: 'tool_use', id: 't2', name: 'x', input: {} }]);
  });
  it('CONTROL: messages with words are untouched (same objects)', () => {
    const a = { role: 'user', content: 'You there?' };
    const b = { role: 'assistant', content: [{ type: 'text', text: 'Yes.' }] };
    const out = dropEmptyMessages([a, b]);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(b);
  });
  it('an empty message that carries reasoning is kept (the reasoning belongs to its turn)', () => {
    expect(dropEmptyMessages([{ role: 'assistant', content: '', reasoningContent: 'thinking' }])).toHaveLength(1);
  });
});
