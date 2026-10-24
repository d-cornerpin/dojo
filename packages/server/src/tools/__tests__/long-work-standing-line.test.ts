// v3.5 B13 — the tool index tells an agent that holds file_append to build long work in a file from the
// start; an agent without file_append is not told to use a tool it does not have.
import { describe, it, expect } from 'vitest';
import { generateToolIndex } from '../categories.js';
import type { ToolDefinition } from '../../agent/tools/types.js';

const tool = (name: string): ToolDefinition => ({ name, description: name, input_schema: { type: 'object', properties: {} } } as unknown as ToolDefinition);
const LINE = '**When an answer deserves to be long** (a report, a document, a story), build it in a file from the start: `file_write` the first part, `file_append` each next part, then hand over the file with a short message. Never attempt one huge reply.';

describe('the long-work standing line', () => {
  it('is in the index for an agent holding file_append (both index forms)', () => {
    expect(generateToolIndex([tool('file_write'), tool('file_append')], [])).toContain(LINE);
    expect(generateToolIndex([tool('file_write'), tool('file_append'), tool('work_open'), tool('scratchpad_set')], ['work_open', 'file_append', 'scratchpad_set'])).toContain(LINE);
  });
  it('is absent for an agent without file_append', () => {
    expect(generateToolIndex([tool('file_read')], [])).not.toContain('When an answer deserves to be long');
  });

  it('fix round 1 (I-1, M-5): the tracker reflex is true and does not coach closing; the long-work line is its own paragraph', () => {
    const idx = generateToolIndex([tool('file_write'), tool('file_append'), tool('work_open'), tool('scratchpad_set')], ['work_open', 'file_append', 'scratchpad_set']);
    expect(idx).toContain('- **Keep the tracker true.**');
    expect(idx).not.toMatch(/Close out tracker tasks the moment|suppresses your reply|resolves them itself|dangling/);
    expect(idx).toContain('\n\n' + LINE);
  });
});
