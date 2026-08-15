// ════════════════════════════════════════════════════════════════════════════════════════
// HL3 — MODEL-VISIBLE MEANS LOGGED. The conformance invariant.
// ════════════════════════════════════════════════════════════════════════════════════════
//
// dsh's own architecture doc states the rule this file enforces: *"Anything that reaches a
// model request must be reconstructable from the log, and a runtime invariant asserts it."*
// The dojo's version is bounded to the TAIL — the engine's own injections — because the
// prefix is already a projection of `messages` rows by construction.
//
// ── WHY THIS IS A GUARD AND NOT A ONE-OFF ───────────────────────────────────────────────
// The steer queue (`steer-queue.ts`) carries injection payloads IN MEMORY. A steer that is
// written, delivered and never persisted is a thing the model demonstrably saw and that no
// query can recover: every hard investigation of the last month began by reconstructing
// what the model saw from thinking dumps. The context receipt is NOT the answer — it is
// debug-gated (`receipt.ts:9`, "off by default") and writes files under `~/.dojo/receipts`,
// so on a normal box it records nothing at all.
//
// The HL3 census (2026-08-15, `task-W26-report.md` §1) measured the gap at `89da110`:
// **29 steer floors, 21 row-backed, 8 row-less across 9 producer sites**, plus one raw
// in-memory splice (`agent/runtime.ts`'s vision-gate nudge) that reached a model without a
// durable row AND without a lane tag. Every one of those nine sites failed clause 1 below
// before the fix landed; the splice failed clause 3.
//
// ── THE TWO HALVES OF THE INVARIANT ─────────────────────────────────────────────────────
//   1. SOURCE (here): every model-visible injection pairs a durable row carrying the SAME
//      content, and no raw insertion into an in-flight model array escapes the tagged,
//      row-backed channel. This is the half that catches the NEXT injection before it ships.
//   2. RUNTIME (`integration.test.ts`, "HL3: model-visible means logged"): a real turn is
//      driven, the array handed to `callModel` is captured, and every non-prefix message in
//      it is shown to be derivable from a durable row. That is the dsh assertion itself.
//
// The two are complementary and neither replaces the other: the source scan cannot prove
// the row and the message agree byte-for-byte at run time, and the driven clause exercises
// one floor, not thirty.
//
// ── WHAT COUNTS AS A DURABLE ROW, AND WHY IT IS NOT AN EVENTS-LANE ROW ──────────────────
// A `messages` row carrying the steer's content, written at injection time with the turn
// number. The sanctioned writers are `persistEngineSteer` (which does the row AND the queue
// entry in one call — RC-19's door), `persistAndBroadcastSystemRow`, `insertMessageIfAbsent`
// and `insertEngineEventIfAbsent`.
//
// HL3's text says "events-lane row". The eight sites this task repaired write `role='system'`
// rows through `persistEngineSteer` instead, and the reason is a measured one rather than a
// preference: an events-lane row written with the default `role='user'` IS LIFTED BACK INTO
// THE MODEL'S CONTEXT on a later turn (`memory/assembler.ts:1357-1361` selects
// `role === 'user' && origin.kind === 'engine'` into `lane.events`; the thrash-gate and
// delegation-hint sites say so in their own comments). That would add model-visible prompt
// bytes on the next turn — a prompt change, which this sitting forbids and which HL3's own
// intent inventory rules out ("rows are receipts, not carriers … zero prompt-byte movement").
// A `role='system'` row is stripped from model context by the assembler, classifies as
// `{ tier: 'agent-only', kind: 'engine-note' }` (`shared/src/visibility.ts:562-585`), and is
// exactly the carrier three of the already-compliant floors were using.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// The registry assembler, not the bare container: importing it is what REGISTERS the
// entries (`prompt/registry/assembler.ts:24` imports `./entries.js` for its side effect), and
// `renderMessageEntry` is the exact function the drain calls, so this clause exercises the
// production path rather than a hand-picked entry object.
import { renderMessageEntry } from '../../../prompt/registry/assembler.js';
import { registeredIds } from '../../../prompt/registry/registry.js';
import type { AssemblyContext } from '../../../prompt/registry/types.js';
import { emptySteerQueue, enqueueSteer, nextSteer } from '../steer-queue.js';
import { SERVER_SRC, engineSources, type EngineSource } from './engine-sources.js';

// ── The corpus ──────────────────────────────────────────────────────────────────────────
//
// The engine (driver + step packages, from the one derivation) PLUS `engine-steer.ts`, the
// steer helper itself — it holds an `enqueueSteer` call of its own and must satisfy the same
// rule, which it does by construction (its row write is two lines above the enqueue).

const ENGINE_STEER_REL = 'agent/v2/engine-steer.ts';
/** The one file outside the engine that mutates the in-flight model array (the vision gate). */
const RUNTIME_REL = 'agent/runtime.ts';

function readRel(rel: string): EngineSource {
  return { rel, text: fs.readFileSync(path.join(SERVER_SRC, rel), 'utf8') };
}

function steerCorpus(): EngineSource[] {
  return [...engineSources(), readRel(ENGINE_STEER_REL)];
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/** Every sanctioned durable-row writer, in the two shapes the tree spells them. */
const ROW_WRITER =
  /persistAndBroadcastSystemRow\(|insertEngineEventIfAbsent\(|insertEngineEvent\(|insertMessageIfAbsent\(|insertMessage\(|insertRow/;

/**
 * The `content:` argument of a steer enqueue, as an IDENTIFIER, or null when the site passes
 * an inline literal.
 *
 * The identifier is what makes the pairing check real rather than proximity-based: a row
 * writer in the same window that persists a DIFFERENT string does not satisfy the rule.
 * `turn-budget.ts` is the live example the rule was calibrated against — its compaction
 * recap sat 53 lines below an unrelated `insertMessageIfAbsent` for the turn-continuation
 * notice, and a plain "is there a row writer nearby" scan would have passed it.
 */
function contentIdentifier(callText: string): string | null {
  const named = callText.match(/content:\s*([A-Za-z_$][\w$]*)\s*[,)}\n]/);
  if (named) return named[1];
  const shorthand = callText.match(/[{,]\s*(content)\s*,/); // `{ floor, content, key }`
  return shorthand ? shorthand[1] : null;
}

interface SteerSite {
  rel: string;
  line: number;      // 1-based
  ident: string | null;
  paired: boolean;
}

function scanSteerSites(): SteerSite[] {
  const out: SteerSite[] = [];
  for (const { rel, text } of steerCorpus()) {
    const lines = text.split('\n');
    lines.forEach((l, i) => {
      if (isCommentLine(l) || !l.includes('enqueueSteer(')) return;
      if (/^\s*(import|export)\b/.test(l)) return;

      // The call text: this line and the twelve below it (the formatter wraps these calls).
      const ident = contentIdentifier(lines.slice(i, i + 13).join('\n'));

      // The window: 70 lines above (the widest real gap is `thrash-gate.ts`, 42 lines) and
      // 10 below, so a writer placed after the enqueue still counts.
      const start = Math.max(0, i - 70);
      const end = Math.min(lines.length - 1, i + 10);
      const window = lines.slice(start, end + 1).join('\n');

      let paired = /steer-row-exempt:/.test(window);
      if (!paired && ident) {
        for (let j = start; j <= end; j++) {
          if (isCommentLine(lines[j]) || !ROW_WRITER.test(lines[j])) continue;
          if (new RegExp(`\\b${ident}\\b`).test(lines.slice(j, j + 13).join('\n'))) { paired = true; break; }
        }
      }
      out.push({ rel, line: i + 1, ident, paired });
    });
  }
  return out;
}

describe('HL3 clause 1: every steer the model can see is also a durable row', () => {
  it('every enqueueSteer site pairs a row writer carrying the SAME content', () => {
    const violations = scanSteerSites()
      .filter((s) => !s.paired)
      .map((s) => `${s.rel}:${s.line} | content=${s.ident ?? '<inline literal>'} | no durable row for this steer`);

    // If this fails: route the steer through `persistEngineSteer(state, {...}, { broadcast })`
    // — it writes the role='system' row AND enqueues the queue entry from the same `content`,
    // so the two can never disagree. If the injection genuinely must not be recorded, add a
    // `steer-row-exempt: <reason>` comment in the block and say why in words.
    expect(violations).toEqual([]);
  });

  it('the scan finds the real population of steer sites (guards against matching nothing)', () => {
    // Non-vacuity, both directions. The floor is deliberately below the live count so a
    // legitimate merger (HL4's job) does not fail this clause, and high enough that a scan
    // which has lost its corpus does.
    const sites = scanSteerSites();
    expect(sites.length).toBeGreaterThanOrEqual(15);
    // …and the identifier extraction is doing work rather than returning null everywhere,
    // which would make the pairing check vacuously strict instead of vacuously loose.
    expect(sites.filter((s) => s.ident !== null).length).toBeGreaterThanOrEqual(10);
  });
});

// ── Clause 2: nothing reaches the model array by the back door ───────────────────────────
//
// `agent/v2/engine-message.ts` is the ONE channel for engine-injected user-role messages and
// it REQUIRES a lane id (F23 made the parameter mandatory precisely so an untagged injection
// cannot hide). Anything that pushes or splices into an in-flight model array directly
// bypasses both the tag and the dedup net — and, at the census, the one site that did also
// had no durable row, so the receipt could neither name it nor recover it.

interface ArraySite { rel: string; line: number; tagged: boolean; rowed: boolean; text: string }

function scanModelArrayInsertions(): ArraySite[] {
  const out: ArraySite[] = [];
  for (const { rel, text } of [...engineSources(), readRel(RUNTIME_REL)]) {
    const lines = text.split('\n');
    lines.forEach((l, i) => {
      if (isCommentLine(l)) return;
      const push = /\bmessages\.push\(/.test(l);
      const insertSplice = /\bmessages\.splice\([^;]*,\s*0\s*,/.test(l);
      if (!push && !insertSplice) return;
      out.push({
        rel, line: i + 1, text: l.trim(),
        tagged: /tagMessageLane|pushEngineMessage/.test(lines.slice(Math.max(0, i - 3), i + 4).join('\n')),
        rowed: ROW_WRITER.test(lines.slice(Math.max(0, i - 30), i + 10).join('\n')),
      });
    });
  }
  return out;
}

describe('HL3 clause 2: no untagged, unlogged injection reaches the model array', () => {
  it('every raw insertion into an in-flight model array is lane-tagged AND row-backed', () => {
    const violations = scanModelArrayInsertions()
      .filter((s) => !s.tagged || !s.rowed)
      .map((s) => `${s.rel}:${s.line} | tagged=${s.tagged} rowed=${s.rowed} | ${s.text.slice(0, 80)}`);

    // If this fails: push through `pushEngineMessage(messages, content, laneId)` (which tags
    // for free) and persist the content as a durable row beside it. An injection the receipt
    // cannot name is classified `organic` — indistinguishable from something the user typed.
    expect(violations).toEqual([]);
  });

  it('the scan actually finds an insertion site (guards against matching nothing)', () => {
    expect(scanModelArrayInsertions().length).toBeGreaterThanOrEqual(1);
  });
});

// ── Clause 3: the carrier is byte-transparent ────────────────────────────────────────────
//
// The row proves what was WRITTEN. This clause is the link that makes it prove what was
// SEEN: the queue entry's content reaches the model unmodified, so `row.content ===
// entry.content === the message the provider was handed`. If `msg.pending-nudge` ever
// started wrapping, prefixing or truncating the steer, every row in the store would become
// an approximation of what the model read, and clause 1 would be guarding the wrong string.

describe('HL3 clause 3: the steer carrier does not alter the bytes it carries', () => {
  it('msg.pending-nudge renders the queue entry content byte-identically', () => {
    expect(registeredIds(), 'msg.pending-nudge is not registered — the drain has no carrier')
      .toContain('msg.pending-nudge');

    const steerText =
      '[Engine hint: the user has not heard anything from you yet this turn.]\nSecond line, and a trailing space. ';
    const q = enqueueSteer(emptySteerQueue(), { floor: 'start-ack', content: steerText, atLoop: 1 });
    const queued = nextSteer(q);
    expect(queued?.content).toBe(steerText);

    const msg = renderMessageEntry('msg.pending-nudge', { pendingSteer: queued!.content } as unknown as AssemblyContext);
    expect(msg).toBeTruthy();
    expect(msg!.role).toBe('user');
    expect(msg!.content).toBe(steerText);
  });

  it('renders nothing when no steer is pending (the drain is the only writer)', () => {
    expect(renderMessageEntry('msg.pending-nudge', { pendingSteer: null } as unknown as AssemblyContext)).toBeNull();
  });
});
