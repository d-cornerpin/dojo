// ════════════════════════════════════════════════════════════════════════════════════════
// PHASE-3 T9 — ONE OWNER FOR THE tool_use ⇄ tool_result PAIRING INVARIANT.
//
// T6 fixed the pairing repair at the provider boundary and extracted it to
// `agent/tool-pairing.ts`, and it recorded in its own module header that a SECOND
// implementation survived in `memory/assembler.ts` (`sanitizeToolBlocks`) — "each copy right
// where the other is wrong" — enumerating it for T9 rather than folding a third unrelated
// cause into T6's one reviewed golden diff. This is that disposition.
//
// ── THE TWO COPIES, AND EXACTLY WHERE THEY DIVERGE (measured, not inherited) ─────────────
// The assembler's copy validates a `tool_use` only when the SINGLE immediately-next message
// carries its result. `repairToolPairing` walks EVERY consecutive result carrier. They agree
// on every shape except one — N parallel calls answered across TWO consecutive carriers:
//
//     [assistant tool_use(a) tool_use(b)]
//     [user      tool_result(a)]
//     [user      tool_result(b)]
//
// On that array the assembler's copy strips `tool_use(b)` AND `tool_result(b)` — a VALID,
// correctly-ordered pair — while `repairToolPairing` strips nothing. Clause 1 shows it.
//
// ── WHY IT NEVER FIRED, AND WHY THAT IS THE ARGUMENT FOR DELETING IT ─────────────────────
// `mergeConsecutiveRoles` runs immediately above the call site and folds two consecutive
// user messages into one, so the divergent shape cannot reach the assembler's copy from the
// assembler's own path. That is a real fact (T6 derived it; re-verified at this HEAD) — and
// it is an UNDECLARED COUPLING between two functions eighty lines apart. Nothing in the tree
// states it, no test held it, and any future task that reorders those two calls or adds a
// second caller re-opens the defect SILENTLY. The requirement is one invariant with one
// owner; the safe way to keep the coupling honest is to not need it.
//
// requirement preserved: "no array reaches a provider carrying a `tool_use` nothing answered
// or a `tool_result` nothing asked for" — owned end to end by `agent/tool-pairing.ts`
// (`repairToolPairing`), which closes BOTH directions and asserts its own postcondition via
// `unpairedToolIds`, at both the assembler's call site and the provider boundary.
//
// Clause 4 is the one that is RED before the change: it fails while the assembler still
// declares a pairing walk of its own.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { repairToolPairing, unpairedToolIds, type PairedMessage } from '../../agent/tool-pairing.js';

const REPO = path.resolve(__dirname, '..', '..', '..', '..', '..');
const src = (rel: string): string => fs.readFileSync(path.join(REPO, rel), 'utf8');
/** Blank comments, keeping line count, so prose ABOUT the deleted copy is never read as one. */
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

// ── the assembler's copy, transcribed from `memory/assembler.ts:2561-2642` at `92b7124` ──
// Kept here so "the copy that was deleted did the wrong thing over this input" is a test
// result rather than a story. It returns a sanitized COPY, which is the contract its call
// site used.
type AsmMsg = { role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> };
function OLD_assembler_sanitizeToolBlocks(messages: AsmMsg[]): AsmMsg[] {
  const validToolUseIds = new Set<string>();
  const validToolResultIds = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!Array.isArray(msg.content)) continue;
    const blocks = msg.content;
    if (msg.role === 'assistant') {
      const useIds = blocks.filter((b) => b.type === 'tool_use' && typeof b.id === 'string').map((b) => b.id as string);
      if (useIds.length === 0) continue;
      const next = i + 1 < messages.length ? messages[i + 1] : null;
      if (next && next.role === 'user' && Array.isArray(next.content)) {
        const resultIds = new Set(
          next.content
            .filter((b) => b.type === 'tool_result' && typeof b.tool_use_id === 'string')
            .map((b) => b.tool_use_id as string),
        );
        for (const uid of useIds) {
          if (resultIds.has(uid)) { validToolUseIds.add(uid); validToolResultIds.add(uid); }
        }
      }
    }
  }

  const sanitized: AsmMsg[] = [];
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) { sanitized.push(msg); continue; }
    const kept = msg.content.filter((b) => {
      if (msg.role === 'assistant' && b.type === 'tool_use') {
        return typeof b.id === 'string' && validToolResultIds.has(b.id);
      }
      if (msg.role === 'user' && b.type === 'tool_result') {
        return typeof b.tool_use_id === 'string' && validToolUseIds.has(b.tool_use_id);
      }
      return true;
    });
    if (kept.length === 0) continue;
    sanitized.push({ ...msg, content: kept });
  }
  return sanitized;
}

const use = (id: string) => ({ type: 'tool_use', id, name: 't', input: {} });
const result = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' });
const text = (t: string) => ({ type: 'text', text: t });

/** N parallel calls answered across TWO consecutive carriers — the divergent shape. */
const splitCarriers = (): AsmMsg[] => [
  { role: 'assistant', content: [use('a'), use('b')] },
  { role: 'user', content: [result('a')] },
  { role: 'user', content: [result('b')] },
];

/** One call answered by a carrier that ALSO holds the user's next question — T6's live shape. */
const mixedCarrier = (): AsmMsg[] => [
  { role: 'assistant', content: [use('a')] },
  { role: 'user', content: [result('a'), text('and what is my locker code?')] },
];

const blocks = (m: AsmMsg | PairedMessage): Array<Record<string, unknown>> =>
  (Array.isArray(m.content) ? m.content : []) as Array<Record<string, unknown>>;
const countType = (ms: Array<AsmMsg | PairedMessage>, t: string): number =>
  ms.reduce((n, m) => n + blocks(m).filter((b) => b.type === t).length, 0);

describe('PHASE-3 T9 — one owner for the tool-pairing invariant', () => {
  it('1. THE DEFECT: the assembler copy strips a VALID pair when parallel calls span two carriers', () => {
    const input = splitCarriers();
    // The input is already correct — nothing to repair.
    expect(unpairedToolIds(input as PairedMessage[]).toolUseWithoutResult).toEqual([]);
    expect(unpairedToolIds(input as PairedMessage[]).toolResultWithoutUse).toEqual([]);

    const out = OLD_assembler_sanitizeToolBlocks(input);

    // It removed `tool_use(b)` and, with it, the `tool_result(b)` message entirely.
    expect(countType(out, 'tool_use')).toBe(1);
    expect(countType(out, 'tool_result')).toBe(1);
    expect(out).toHaveLength(2);
  });

  it('2. THE SURVIVOR: repairToolPairing leaves the same array untouched', () => {
    const input = splitCarriers() as unknown as PairedMessage[];
    const report = repairToolPairing(input);
    expect(report).toEqual({ strippedToolUse: 0, strippedToolResult: 0, droppedMessages: 0 });
    expect(countType(input, 'tool_use')).toBe(2);
    expect(countType(input, 'tool_result')).toBe(2);
    expect(input).toHaveLength(3);
  });

  it('3. NOT A ONE-SIDED REPLACEMENT — both are correct on the mixed carrier, and both repair a real orphan', () => {
    // The assembler's copy never required purity, so the mixed carrier is the half it got
    // right and `model.ts`'s pre-T6 copy got wrong. Stated as a test so the deletion is not
    // read as "the assembler's copy was simply broken".
    expect(countType(OLD_assembler_sanitizeToolBlocks(mixedCarrier()), 'tool_use')).toBe(1);
    const mixed = mixedCarrier() as unknown as PairedMessage[];
    expect(repairToolPairing(mixed)).toEqual({ strippedToolUse: 0, strippedToolResult: 0, droppedMessages: 0 });

    // And the survivor still does the job the call site is there for: a genuine orphan goes.
    const orphaned = [
      { role: 'assistant', content: [use('z')] },
      { role: 'user', content: [text('unrelated')] },
    ] as unknown as PairedMessage[];
    const rep = repairToolPairing(orphaned);
    expect(rep.strippedToolUse).toBe(1);
    expect(rep.droppedMessages).toBe(1);
    expect(unpairedToolIds(orphaned)).toEqual({ toolUseWithoutResult: [], toolResultWithoutUse: [] });
  });

  it('4. CONFORMANCE: `memory/assembler.ts` declares no pairing walk of its own — it imports the one owner', () => {
    const s = stripComments(src('packages/server/src/memory/assembler.ts'));
    // The deleted copy's own identifiers. Any of them back in live code is a second owner.
    expect(s).not.toMatch(/function\s+sanitizeToolBlocks/);
    expect(s).not.toMatch(/validToolUseIds/);
    expect(s).not.toMatch(/validToolResultIds/);
    // And it must actually use the survivor, or the invariant is enforced nowhere here.
    expect(s).toMatch(/repairToolPairing/);
    expect(s).toMatch(/from '\.\.\/agent\/tool-pairing\.js'/);
  });

  it('5. the WALK is declared once, tree-wide — both call sites go through the one owner', () => {
    // `agent/model.ts` keeps `sanitizeOrphanToolBlocks` as a NAMED WRAPPER on purpose (it
    // carries the log line the 14/14 correlation was measured against), so the thing to
    // forbid is a re-declared WALK, not a re-used name. These three identifiers are what a
    // second walk needs and a wrapper never has.
    for (const rel of [
      'packages/server/src/memory/assembler.ts',
      'packages/server/src/agent/model.ts',
    ]) {
      const s = stripComments(src(rel));
      expect(s, rel).not.toMatch(/validToolUseIds|validToolResultIds|isPureToolResultMessage/);
      expect(s, rel).toMatch(/repairToolPairing/);
    }
    // The declaration lives in exactly one file.
    expect(stripComments(src('packages/server/src/agent/tool-pairing.ts')))
      .toMatch(/export function repairToolPairing/);
  });
});
