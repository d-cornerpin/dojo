// The tool_use / tool_result pairing repair: nothing answered or asked for reaches a provider, and a valid
// pairing (parallel calls across several result carriers, results beside folded user text) is left whole.
import { describe, it, expect } from 'vitest';
import {
  repairToolPairing,
  isToolResultCarrier,
  type PairedMessage,
} from '../tool-pairing.js';

// Nothing is left to repair: a second repair of a copy strips nothing in either direction.
const settled = (msgs: PairedMessage[]): void =>
  expect(repairToolPairing(structuredClone(msgs))).toEqual({ strippedToolUse: 0, strippedToolResult: 0, droppedMessages: 0 });

const use = (id: string) => ({ type: 'tool_use', id, name: 'work_update', input: {} });
const res = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: '[FILED] ok' });
const text = (t: string) => ({ type: 'text', text: t });

/** Parallel calls answered in one carrier that also holds the folded user text, then an engine hint. */
function parallelCallsWithFoldedText(): PairedMessage[] {
  return [
    { role: 'assistant', content: [use('call_prev_dNov4438')] },
    { role: 'user', content: [res('call_prev_dNov4438')] },
    { role: 'assistant', content: [use('call_00_Y6rqPhThsFCOj4pKR9uo8052'), use('call_01_gH2mQTh08Wj39dg5fjJ82834')] },
    {
      role: 'user',
      content: [
        res('call_00_Y6rqPhThsFCOj4pKR9uo8052'),
        res('call_01_gH2mQTh08Wj39dg5fjJ82834'),
        text("[Jul 31, 2026, 10:37 PM] What's my locker code at the north gym?"),
      ],
    },
    { role: 'user', content: '[Engine hint: respond only to the newest incoming item…]' },
  ];
}

describe('a carrier holding results beside folded user text', () => {
  it('is a carrier', () => {
    const mixed = parallelCallsWithFoldedText()[3];
    expect((mixed.content as Array<{ type: string }>).every((b) => b.type === 'tool_result')).toBe(false);
    expect(isToolResultCarrier(mixed)).toBe(true);
  });

  it('leaves the array alone: nothing was orphaned, so nothing is repaired', () => {
    const msgs = parallelCallsWithFoldedText();
    const report = repairToolPairing(msgs);
    expect(report).toEqual({ strippedToolUse: 0, strippedToolResult: 0, droppedMessages: 0 });
    expect(msgs).toHaveLength(5);
    settled(msgs);
  });
});

describe('both directions: the postcondition', () => {
  it('an unanswered tool_use is stripped', () => {
    const msgs: PairedMessage[] = [
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: [text('working'), use('call_a')] },
      { role: 'user', content: 'never mind' },
    ];
    const report = repairToolPairing(msgs);
    expect(report.strippedToolUse).toBe(1);
    expect(msgs[1].content).toEqual([text('working')]);
    settled(msgs);
  });

  it('an assistant message left with nothing is dropped, not emptied', () => {
    const msgs: PairedMessage[] = [
      { role: 'user', content: 'do it' },
      { role: 'assistant', content: [use('call_a')] },
      { role: 'user', content: 'never mind' },
    ];
    const report = repairToolPairing(msgs);
    expect(report.droppedMessages).toBe(1);
    expect(msgs).toHaveLength(2);
  });

  it('results split by a non-carrier: the unanswered use and the stranded result both go', () => {
    const msgs: PairedMessage[] = [
      { role: 'assistant', content: [use('call_a'), use('call_b')] },
      { role: 'user', content: [res('call_a')] },
      { role: 'user', content: 'an ordinary message that carries no result at all' },
      { role: 'user', content: [res('call_b')] },
    ];
    const report = repairToolPairing(msgs);
    expect(report.strippedToolUse).toBe(1);
    expect(report.strippedToolResult).toBe(1);
    settled(msgs);
  });

  it('a user message left with nothing but a stranded result is dropped', () => {
    const msgs: PairedMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'user', content: [res('call_gone')] },
    ];
    repairToolPairing(msgs);
    expect(msgs).toHaveLength(1);
    settled(msgs);
  });

  it('text blocks beside a stranded result survive, only the result block goes', () => {
    const msgs: PairedMessage[] = [
      { role: 'user', content: [res('call_gone'), text('and here is my actual question')] },
    ];
    repairToolPairing(msgs);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toEqual([text('and here is my actual question')]);
  });
});

describe('parallel calls answered across several carriers', () => {
  it('N parallel calls answered by N separate consecutive carriers keep every tool_use', () => {
    const msgs: PairedMessage[] = [
      { role: 'assistant', content: [use('call_a'), use('call_b'), use('call_c')] },
      { role: 'user', content: [res('call_a')] },
      { role: 'user', content: [res('call_b')] },
      { role: 'user', content: [res('call_c')] },
    ];
    const report = repairToolPairing(msgs);
    expect(report).toEqual({ strippedToolUse: 0, strippedToolResult: 0, droppedMessages: 0 });
    expect((msgs[0].content as unknown[]).length).toBe(3);
  });

  it('keep every tool_use when the last carrier also carries the folded user question', () => {
    const msgs: PairedMessage[] = [
      { role: 'assistant', content: [use('call_a'), use('call_b')] },
      { role: 'user', content: [res('call_a')] },
      { role: 'user', content: [res('call_b'), text('[Jul 31, 2026, 10:37 PM] and another thing')] },
    ];
    expect(repairToolPairing(msgs).strippedToolUse).toBe(0);
  });

  it('an ordinary user message stops the walk: a later result does not answer backwards', () => {
    const msgs: PairedMessage[] = [
      { role: 'assistant', content: [use('call_a')] },
      { role: 'user', content: 'a plain question, no results here' },
      { role: 'user', content: [res('call_a')] },
    ];
    const report = repairToolPairing(msgs);
    expect(report.strippedToolUse).toBe(1);
    expect(report.strippedToolResult).toBe(1);
    settled(msgs);
  });
});

describe('isToolResultCarrier', () => {
  it('an assistant message is not a carrier whatever it holds', () => {
    expect(isToolResultCarrier({ role: 'assistant', content: [res('x')] })).toBe(false);
  });
  it('string content is not a carrier', () => {
    expect(isToolResultCarrier({ role: 'user', content: 'text' })).toBe(false);
  });
  it('an empty block array is not a carrier', () => {
    expect(isToolResultCarrier({ role: 'user', content: [] })).toBe(false);
  });
  it('a text-only block array is not a carrier', () => {
    expect(isToolResultCarrier({ role: 'user', content: [text('hi')] })).toBe(false);
  });
  it("role 'tool' carries too", () => {
    expect(isToolResultCarrier({ role: 'tool', content: [res('x')] })).toBe(true);
  });
});

describe('safety', () => {
  it('an array with no tool blocks at all is untouched', () => {
    const msgs: PairedMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    const copy = JSON.parse(JSON.stringify(msgs));
    expect(repairToolPairing(msgs)).toEqual({ strippedToolUse: 0, strippedToolResult: 0, droppedMessages: 0 });
    expect(msgs).toEqual(copy);
  });

  it('an empty array is not a crash', () => {
    const msgs: PairedMessage[] = [];
    expect(() => repairToolPairing(msgs)).not.toThrow();
    expect(msgs).toEqual([]);
  });
});
