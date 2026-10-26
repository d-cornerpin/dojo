// ════════════════════════════════════════════════════════════════════════════════════════
// ARG SHAPE + LOG SLICE — THE TWO PURE HELPERS A REPORT MAY LEAK THROUGH (DOJO-REPORT T3).
//
// These two helpers decide what a report is ALLOWED to say. `arg-shape.ts` reduces a call's
// arguments to their shape — key, JSON type, byte size — and never a value, and reads every
// tool call out of the tail from assistant blocks only; `log-slice.ts` keeps a report from
// re-swallowing an earlier report's own text. A slip in either leaks argument content or drops
// the wrong tool call. They are pure and untested; this file pins their behaviour on v35.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import { shapeOfArgs, toolCallsFromTail, UNDECLARED_ARG } from '../arg-shape.js';
import { withoutOwnPayload } from '../log-slice.js';
import type { LogRow } from '../log-slice.js';

describe('shapeOfArgs — sizes and types, never a value', () => {
  it('an unknown tool hides every key as UNDECLARED_ARG, each value measured not emitted', () => {
    expect(shapeOfArgs('no_such_tool', { a: 'xy', b: [1, 2], c: null, d: { e: 1 } })).toEqual({
      argShape: [
        { key: UNDECLARED_ARG, type: 'string', bytes: 4 },
        { key: UNDECLARED_ARG, type: 'array', bytes: 5 },
        { key: UNDECLARED_ARG, type: 'null', bytes: 4 },
        { key: UNDECLARED_ARG, type: 'object', bytes: 7 },
      ],
      argsTotalBytes: 41,
    });
  });

  it('a non-object arg yields an empty shape, but the serialized size is kept', () => {
    expect(shapeOfArgs('x', null)).toEqual({ argShape: [], argsTotalBytes: 4 });
    expect(shapeOfArgs('x', [1])).toEqual({ argShape: [], argsTotalBytes: 3 });
  });
});

describe('toolCallsFromTail — every tool call in the tail, oldest first', () => {
  it('reads assistant tool_use blocks only, across both content forms, failing closed on the rest', () => {
    const rows: { role: string; content: unknown }[] = [
      // (1) an assistant array with a tool_use plus a sibling text block.
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'x', input: { a: 1 }, id: 'i1' },
          { type: 'text', text: 'hello' },
        ],
      },
      // (2) a tool_use carried on a USER row — not the model's, so it is ignored.
      { role: 'user', content: [{ type: 'tool_use', name: 'z', input: { q: 1 }, id: 'iz' }] },
      // (3) an assistant whose content is a JSON string that parses to a tool_use block.
      { role: 'assistant', content: JSON.stringify([{ type: 'tool_use', name: 'y' }]) },
      // (4) an assistant whose content is a non-JSON string — contributes nothing.
      { role: 'assistant', content: 'not json' },
      // (5) an assistant array of unrecognised shapes — null, a number, and a tool_use
      //     whose name is not a string; none of them is a call.
      { role: 'assistant', content: [null, 5, { type: 'tool_use', name: 7 }] },
    ];
    expect(toolCallsFromTail(rows)).toStrictEqual([
      { name: 'x', args: { a: 1 }, id: 'i1' },
      { name: 'y', args: undefined, id: null },
    ]);
  });
});

describe('withoutOwnPayload — the row survives, its own payload goes', () => {
  const row = (meta: Record<string, unknown>): LogRow =>
    ({ timestamp: 't', level: 'info', message: 'm', agentId: 'a', meta } as unknown as LogRow);

  it('drops args and rawSnippet from a dojo_report row and names what it dropped', () => {
    const r = withoutOwnPayload(row({ tool: 'dojo_report', args: { z: 1 }, rawSnippet: 's', keep: 1 }));
    const m = r.meta as Record<string, unknown>;
    expect(m.tool).toBe('dojo_report');
    expect(m.keep).toBe(1);
    expect(m).not.toHaveProperty('args');
    expect(m).not.toHaveProperty('rawSnippet');
    // the drop note is prose; pin only the field list, not the sentence.
    expect(String(m.omitted)).toContain('args, rawSnippet');
  });

  it('returns the very same row when it is not a dojo_report row, or carries no payload', () => {
    const other = row({ tool: 'other', args: { z: 1 } });
    expect(withoutOwnPayload(other)).toBe(other);
    const noPayload = row({ tool: 'dojo_report', keep: 1 });
    expect(withoutOwnPayload(noPayload)).toBe(noPayload);
  });
});
