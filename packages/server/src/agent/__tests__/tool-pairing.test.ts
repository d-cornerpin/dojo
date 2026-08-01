// ════════════════════════════════════════════════════════════════════════════════════════
// PHASE-3 T6 — the tool_use ⇄ tool_result pairing repair.
//
// The first four clauses are the DEFECT, reproduced from live data (T4's day-0 finding,
// 14 of 17 divergences; re-reproduced at T6's HEAD from receipt 1785562624007-t1649-i1 and
// recorded in `assembly-validation.jsonl` at 2026-08-01T05:37:04.008Z). The OLD walk is
// reproduced verbatim beside the new one, so the fix is SHOWN — the same input through both
// implementations, one creating the divergence and one not — rather than asserted.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import {
  repairToolPairing,
  isToolResultCarrier,
  unpairedToolIds,
  type PairedMessage,
} from '../tool-pairing.js';

// ── the PRE-FIX arithmetic, byte-for-byte from agent/model.ts:238-282 at 694fb96 ─────────
// Kept so "the old one did the opposite over the same input" is a test result, not a story.
function OLD_sanitizeOrphanToolBlocks(messages: Array<{ role: string; content: unknown }>): void {
  const isPureToolResultMessage = (m: { role: string; content: unknown }): boolean => {
    if (m.role !== 'user' && m.role !== 'tool') return false;
    if (!Array.isArray(m.content)) return false;
    const blocks = m.content as Array<Record<string, unknown>>;
    if (blocks.length === 0) return false;
    return blocks.every((b) => b.type === 'tool_result');
  };
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    const blocks = msg.content as Array<Record<string, unknown>>;
    const useIds = blocks
      .filter((b) => b.type === 'tool_use' && typeof b.id === 'string')
      .map((b) => b.id as string);
    if (useIds.length === 0) continue;
    const resultIds = new Set<string>();
    let j = i + 1;
    while (j < messages.length && isPureToolResultMessage(messages[j])) {
      for (const b of messages[j].content as Array<Record<string, unknown>>) {
        if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') resultIds.add(b.tool_use_id as string);
      }
      j++;
    }
    const orphanIds = useIds.filter((id) => !resultIds.has(id));
    if (orphanIds.length === 0) continue;
    const orphanSet = new Set(orphanIds);
    const kept = blocks.filter((b) => !(b.type === 'tool_use' && orphanSet.has(b.id as string)));
    if (kept.length === 0) messages.splice(i, 1);
    else messages[i] = { ...msg, content: kept };
  }
}

const use = (id: string) => ({ type: 'tool_use', id, name: 'work_update', input: {} });
const res = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: '[FILED] ok' });
const text = (t: string) => ({ type: 'text', text: t });

/**
 * The live array, at the shape the receipt recorded (messages 27-31 of 36).
 *
 * The excerpt starts at 27, not 28, ON PURPOSE: message 28 is a `tool_result` and its
 * `tool_use` is the assistant message above it. An excerpt that began at 28 would present a
 * genuinely unpaired result to a function whose whole subject is pairing — the fixture, not
 * the product, would be the thing under test. (This was caught by the repair reporting a
 * strip on an array the header says nothing should happen to.)
 */
function liveDivergentArray(): PairedMessage[] {
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

describe('the derived failing branch — MIXED BLOCKS', () => {
  it('the PRE-FIX predicate rejects the very message holding the results', () => {
    const mixed = liveDivergentArray()[3];
    // role and array and non-empty all hold; the ONLY early-out left is "every block is a
    // tool_result", and it is false because of the folded user text.
    expect(mixed.role).toBe('user');
    expect(Array.isArray(mixed.content)).toBe(true);
    expect((mixed.content as unknown[]).length).toBeGreaterThan(0);
    expect((mixed.content as Array<{ type: string }>).every((b) => b.type === 'tool_result')).toBe(false);
    // …and the fixed predicate accepts it, because it CARRIES results.
    expect(isToolResultCarrier(mixed)).toBe(true);
  });

  it('THE OLD WALK CREATES THE OTHER ORPHAN over the live array (the 14/17 divergence)', () => {
    const msgs = liveDivergentArray();
    expect(unpairedToolIds(msgs).toolResultWithoutUse).toEqual([]);   // sound on the way in
    OLD_sanitizeOrphanToolBlocks(msgs);
    const after = unpairedToolIds(msgs);
    expect(msgs).toHaveLength(4);                                     // the assistant was spliced out
    expect(after.toolResultWithoutUse).toEqual([
      'call_00_Y6rqPhThsFCOj4pKR9uo8052',
      'call_01_gH2mQTh08Wj39dg5fjJ82834',
    ]);
  });

  it('THE FIX LEAVES IT ALONE — nothing was orphaned, so nothing is repaired', () => {
    const msgs = liveDivergentArray();
    const report = repairToolPairing(msgs);
    expect(report).toEqual({ strippedToolUse: 0, strippedToolResult: 0, droppedMessages: 0 });
    expect(msgs).toHaveLength(5);
    expect(unpairedToolIds(msgs)).toEqual({ toolUseWithoutResult: [], toolResultWithoutUse: [] });
  });
});

describe('both directions — the postcondition', () => {
  it('a genuinely unanswered tool_use is still stripped', () => {
    const msgs: PairedMessage[] = [
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: [text('working'), use('call_a')] },
      { role: 'user', content: 'never mind' },
    ];
    const report = repairToolPairing(msgs);
    expect(report.strippedToolUse).toBe(1);
    expect(msgs[1].content).toEqual([text('working')]);
    expect(unpairedToolIds(msgs)).toEqual({ toolUseWithoutResult: [], toolResultWithoutUse: [] });
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

  // The case fix 1 does NOT cover, which is why the repair is two-directional.
  it('RESULTS SPLIT BY A NON-CARRIER — the strip would strand the second result; it does not', () => {
    const msgs: PairedMessage[] = [
      { role: 'assistant', content: [use('call_a'), use('call_b')] },
      { role: 'user', content: [res('call_a')] },
      { role: 'user', content: 'an ordinary message that carries no result at all' },
      { role: 'user', content: [res('call_b')] },
    ];
    const before = [...msgs];
    OLD_sanitizeOrphanToolBlocks(before as Array<{ role: string; content: unknown }>);
    expect(unpairedToolIds(before).toolResultWithoutUse).toEqual(['call_b']);  // the old one strands it

    const report = repairToolPairing(msgs);
    expect(report.strippedToolUse).toBe(1);
    expect(report.strippedToolResult).toBe(1);
    expect(unpairedToolIds(msgs)).toEqual({ toolUseWithoutResult: [], toolResultWithoutUse: [] });
  });

  it('a user message left with nothing but a stranded result is dropped', () => {
    const msgs: PairedMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'user', content: [res('call_gone')] },
    ];
    repairToolPairing(msgs);
    expect(msgs).toHaveLength(1);
    expect(unpairedToolIds(msgs).toolResultWithoutUse).toEqual([]);
  });

  it('text blocks beside a stranded result survive — only the result block goes', () => {
    const msgs: PairedMessage[] = [
      { role: 'user', content: [res('call_gone'), text('and here is my actual question')] },
    ];
    repairToolPairing(msgs);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toEqual([text('and here is my actual question')]);
  });
});

describe('the 2026 parallel-call incident stays fixed ("agent repeats itself")', () => {
  it('N parallel calls answered by N SEPARATE consecutive carriers keep every tool_use', () => {
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

  it('…and still does when the LAST carrier also carries the folded user question', () => {
    const msgs: PairedMessage[] = [
      { role: 'assistant', content: [use('call_a'), use('call_b')] },
      { role: 'user', content: [res('call_a')] },
      { role: 'user', content: [res('call_b'), text('[Jul 31, 2026, 10:37 PM] and another thing')] },
    ];
    expect(repairToolPairing(msgs).strippedToolUse).toBe(0);
  });

  it('an ordinary user message still STOPS the walk — a later result does not answer backwards', () => {
    const msgs: PairedMessage[] = [
      { role: 'assistant', content: [use('call_a')] },
      { role: 'user', content: 'a plain question, no results here' },
      { role: 'user', content: [res('call_a')] },
    ];
    const report = repairToolPairing(msgs);
    expect(report.strippedToolUse).toBe(1);
    expect(report.strippedToolResult).toBe(1);
    expect(unpairedToolIds(msgs)).toEqual({ toolUseWithoutResult: [], toolResultWithoutUse: [] });
  });
});

describe('isToolResultCarrier — every early-out named', () => {
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
