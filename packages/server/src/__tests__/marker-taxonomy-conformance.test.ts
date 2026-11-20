// ════════════════════════════════════════════════════════════════════════════════════════
// ONE MARKER TAXONOMY — the conformance walk. PHASE-3 T5 Step 1.
// Research 06 requirement E17: "one shared module with anchored + unanchored exports for
// inbound-A2A, platform-noise, engine-scaffolding, new-session and fresh-read sentinels;
// ZERO LOCAL RE-DECLARATIONS."
//
// This is the sibling of `marker-ownership.test.ts` (PHASE-1 T8) and it works the same way,
// for the reason that file states: a string-literal scan is a starting list, never a
// completion proof, so the proof is a check that RUNS and fails the build the day a second
// matcher appears. T8 policed the DISPLAY markers; this polices the ASSEMBLY markers —
// the families research 06 §5 found written seven ways across the tree.
//
// Two halves:
//   A. BEHAVIOUR — each family's matchers actually match the live spellings, and the
//      four named drifts are closed. These are the clauses that would have caught the
//      defects, so they are written as the defect, not as the fix.
//   B. OWNERSHIP — nobody re-declares a shape the shared module owns.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import { A2A_INBOUND_PREFIXES, A2A_INBOUND_RE, A2A_INBOUND_ANYWHERE_RE, A2A_ENVELOPE_RE, A2A_THREAD_RE, parseA2AThreadShort, SOURCE_ENVELOPE_PREFIXES, ENGINE_SCAFFOLD_PREFIXES, ENGINE_SCAFFOLD_RE, NEW_SESSION_BRACKET_RE, NEW_SESSION_BRACKET_ANYWHERE_RE, TECHNIQUE_FRESH_SENTINEL, TECHNIQUE_FRESH_HEADER_RE, parseTechniqueFreshRead } from '@dojo/shared';
import { FXID } from '../../../../deploy/checks/fixture-vocabulary.mjs';

// ════════════════════════════════════════════════════════════════════════════════════════
// A. BEHAVIOUR — the four named drifts, written as the defect
// ════════════════════════════════════════════════════════════════════════════════════════

describe('E18 drift 1 — one flag, not two (the /i seed pair)', () => {
  it('matches BOTH cases of the modern envelope from the ONE matcher', () => {
    expect(A2A_INBOUND_RE.test('[A2A:REQUEST thread:bp0atnn9 from:maddy] hi')).toBe(true);
    expect(A2A_INBOUND_RE.test('[a2a:request thread:bp0atnn9 from:maddy] hi')).toBe(true);
  });

  it('the anchored and unanchored forms are built from ONE prefix list', () => {
    for (const p of A2A_INBOUND_PREFIXES) {
      expect(A2A_INBOUND_RE.test(`${p}x`), `anchored misses ${p}`).toBe(true);
      expect(A2A_INBOUND_ANYWHERE_RE.test(`padding ${p}x`), `unanchored misses ${p}`).toBe(true);
    }
    // and the anchored one is genuinely anchored, or it is not two forms at all
    expect(A2A_INBOUND_RE.test('some prose then [A2A: later')).toBe(false);
  });
});

describe('E18 drift 2 — GROUP BROADCAST is in the taxonomy', () => {
  it('the shared list carries it (it was in neither shared module)', () => {
    expect(A2A_INBOUND_PREFIXES).toContain('[SOURCE: GROUP BROADCAST FROM');
    expect(SOURCE_ENVELOPE_PREFIXES).toContain('[SOURCE: GROUP BROADCAST FROM');
  });

  it('a broadcast is inbound PEER traffic, never the owner speaking', () => {
    const row = '[SOURCE: GROUP BROADCAST FROM maddy] the deck is ready';
    expect(A2A_INBOUND_RE.test(row)).toBe(true);
    expect(SOURCE_ENVELOPE_PREFIXES.some((pre) => row.startsWith(pre))).toBe(true);
  });
});

describe('E18 drift 3 — the [System note:] colon-requirement leak', () => {
  it('classifies [System note: …] as engine scaffolding, not owner chat', () => {
    // The old ENGINE_PREFIXES had '[System:' (colon REQUIRED) and '[SYSTEM' (case
    // SENSITIVE). '[System note:' matched neither, so it reached deriveOrigin's fallthrough
    // and came out kind:'user' relation:'owner'.
    expect(ENGINE_SCAFFOLD_RE.test('[System note: the user renamed you]')).toBe(true);
    expect(ENGINE_SCAFFOLD_PREFIXES).toContain('[System note');
  });

  it('still matches the forms that already worked, in both cases', () => {
    for (const s of ['[System: reset]', '[SYSTEM] x', '[Engine hint: y]', '[CONTINUITY BRIEF]',
      '[Context note: the owner pressed Stop on your previous work]', '[DOJO technique]']) {
      expect(ENGINE_SCAFFOLD_RE.test(s), `${s} is not recognised`).toBe(true);
    }
  });
});

describe('E18 drift 4 — thread ids are not hex', () => {
  it('parses a NAMED thread id, which the [0-9a-f]{8} form silently dropped', () => {
    // Measured on the live body at T5: of 250 parseable `thread:` tokens, 70 are not hex.
    expect(parseA2AThreadShort('[A2A:POKE thread:bp0atnn9 from:pm] x')).toBe('bp0atnn9');
    expect(parseA2AThreadShort('[A2A:POKE thread:pm-review-2026-06-25 from:pm] x'))
      .toBe('pm-revie');            // slice(0,8) — a2a_replies stores the FULL id
    expect(/^[0-9a-f]{8}$/.test('bp0atnn9')).toBe(false);   // the old pattern's blind spot
  });

  it('still parses a hex id, and the envelope regex agrees with the thread regex', () => {
    expect(parseA2AThreadShort(`[A2A:REPLY thread:9006a872 from:${FXID.n5}] x`)).toBe('9006a872');
    const m = A2A_ENVELOPE_RE.exec(`[A2A:REPLY thread:bp0atnn9 from:${FXID.n5}] x`);
    expect(m?.[2]).toBe('bp0atnn9');
    expect(A2A_THREAD_RE.exec('thread:bp0atnn9]')?.[1]).toBe('bp0atnn9');
  });

  it('returns null rather than a wrong answer when there is no thread', () => {
    expect(parseA2AThreadShort('no marker here')).toBeNull();
    expect(parseA2AThreadShort(null)).toBeNull();
  });
});

describe('the new-session family — both live spellings, and no false positive', () => {
  it('matches the bracket form AND the dated form', () => {
    // platform-noise.ts required `\[New Session\]` and therefore missed the dated form,
    // which is what the attachment tests write.
    expect(NEW_SESSION_BRACKET_RE.test('[New Session] Your previous conversation…')).toBe(true);
    expect(NEW_SESSION_BRACKET_RE.test('[New Session: 2026-05-04 — fresh context]')).toBe(true);
    expect(NEW_SESSION_BRACKET_ANYWHERE_RE.test('prefix [New Session] suffix')).toBe(true);
  });

  it('does NOT match a prose sentence that merely starts the same way', () => {
    // receipt.ts tested `startsWith('[New Session')` with no closer at all.
    expect(NEW_SESSION_BRACKET_RE.test('[New Sessions are great]')).toBe(false);
  });
});

describe('the fresh-read sentinel — one literal, one extractor', () => {
  it('the extractor pulls the technique name', () => {
    const body = `${TECHNIQUE_FRESH_SENTINEL} deep-research (2026-08-01T00:00:00.000Z)\nbody`;
    expect(parseTechniqueFreshRead(body)).toBe('deep-research');
    expect(TECHNIQUE_FRESH_HEADER_RE.test(body)).toBe(true);
  });

  it('returns null on anything else, rather than a partial match', () => {
    expect(parseTechniqueFreshRead('══ TECHNIQUE FRESH READ ══ no-paren')).toBeNull();
    expect(parseTechniqueFreshRead('unrelated')).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// B. OWNERSHIP — zero local re-declarations
// ════════════════════════════════════════════════════════════════════════════════════════

/** A shape the shared module owns, how a SECOND declaration is recognised, and every file
 *  still holding one with the reason it survives. */
interface OwnedShape {
  name: string;
  exports: string[];
  /** Matches only what a re-DECLARATION looks like, never prose that names the marker. */
  pattern: RegExp;
  allow: Record<string, string>;
}

const SHAPES: OwnedShape[] = [
  {
    name: 'the inbound-A2A alternation',
    exports: ['A2A_INBOUND_RE', 'A2A_INBOUND_ANYWHERE_RE', 'A2A_INBOUND_PREFIXES'],
    // The alternation itself: an escaped `[A2A:` next to an escaped `[SOURCE: AGENT`.
    pattern: /\\\[A2A:\|\\\[SOURCE: AGENT MESSAGE FROM/,
    allow: {},
  },
  {
    name: 'the hex-only thread parse',
    exports: ['A2A_THREAD_RE', 'parseA2AThreadShort'],
    // The defect shape itself. It must never come back, in any file, ever.
    pattern: /thread:\(\[0-9a-f/i,
    allow: {},
  },
  {
    name: 'the A2A envelope regex',
    exports: ['A2A_ENVELOPE_RE'],
    pattern: /\\\[A2A:\(\[A-Z\]\+\)/,
    allow: {},
  },
  {
    name: 'the technique fresh-read sentinel',
    exports: ['TECHNIQUE_FRESH_SENTINEL', 'TECHNIQUE_FRESH_HEADER_RE', 'parseTechniqueFreshRead'],
    pattern: /['"`/]══ TECHNIQUE FRESH READ ══/,
    allow: {},
  },
  {
    name: 'the engine-scaffolding prefix list',
    exports: ['ENGINE_SCAFFOLD_PREFIXES', 'ENGINE_SCAFFOLD_RE'],
    // A LIST literal opening with '[SOURCE:' and containing '[System' — the origin.ts shape.
    pattern: /\[\s*'\[SOURCE:',\s*'\[System/,
    allow: {},
  },
];

describe('ownership — one declaration per shape', () => {

  for (const s of SHAPES) {

    it(`${s.name}: the owner exports it (${s.exports.join(', ')})`, async () => {
      const shared = await import('@dojo/shared') as Record<string, unknown>;
      for (const sym of s.exports) {
        expect(shared[sym], `@dojo/shared does not export ${sym}`).toBeDefined();
      }
    });
  }
});
