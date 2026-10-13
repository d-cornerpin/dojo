// ════════════════════════════════════════════════════════════════════════════════════════
// t140 — THE CENSUS: "is the old mechanism gone?", answered by counting, in both directions.
//
// Every clause reads the SHIPPED server source with comments STRIPPED first (G4: a clause a
// comment could satisfy tests the comment). A deletion is proven by a token count of zero; a
// replacement is proven by the exact SET of files that call it, so a new caller added anywhere
// else reds the clause as surely as the old mechanism coming back does.
//
// The behaviour each deletion changed is pinned by the t140 witness files beside the modules
// (the gate, the boundary, the dialed window, the migration); this file only says the old code
// cannot quietly return.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The step packages' location comes from the ONE shared derivation (the guard-corpus census
// refuses a test that spells that path by hand).
import { ENGINE_STEPS_REL } from '../../agent/v2/__tests__/engine-sources.js';

const GATE_REL = `${ENGINE_STEPS_REL}/pre-call-gates/context-gates.ts`;
const REFIT_REL = `${ENGINE_STEPS_REL}/call-llm/reassemble-for-fit.ts`;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../..');   // packages/server/src

function shippedFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      shippedFiles(full, out);
    } else if (/\.ts$/.test(entry.name) && !/\.(test|spec)\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Block comments, then line comments that are not inside a URL scheme. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const FILES = shippedFiles(SRC).map((f) => ({ rel: path.relative(SRC, f), code: stripComments(fs.readFileSync(f, 'utf-8')) }));

/** The shipped files whose CODE contains `needle`, as sorted relative paths. */
function filesWith(needle: string | RegExp): string[] {
  return FILES
    .filter(({ code }) => (typeof needle === 'string' ? code.includes(needle) : needle.test(code)))
    .map(({ rel }) => rel)
    .sort();
}

describe('t140 census — the row-gap drain and the proactive arm are gone', () => {
  it.each([
    'UNCOMPACTED_GAP_THRESHOLD',
    'getUncompactedGapCount',
    'needsCompactionByGap',
    'background gap-drain',
    'Running proactive leaf compaction',
    'proactiveLeafTokens',
  ])('no shipped code says %s', (token) => {
    expect(filesWith(token)).toEqual([]);
  });

  it('the replacement is called from exactly the two doors that decide to condense, and nowhere else', () => {
    expect(filesWith(/\browsLeavingView\(/)).toEqual([
      GATE_REL,
      'memory/compaction.ts',
      'memory/tail-horizon.ts',   // its own declaration
    ]);
    // And the gate APPLIES it: the routine condense is handed the leaving span, not a count.
    const gate = FILES.find((f) => f.rel === GATE_REL)!.code;
    expect(gate).toMatch(/const leaving = rowsLeavingView\(agentId, \{ freshTailCount: getFreshTailCount\(contextWindow\) \}, \{ viewFull \}\);/);
    expect(gate).toMatch(/checkAndCompact\(agentId, dialModelId, contextWindow, \{\s*leaving,/);
  });

  it('the ceiling and the trim bound each have ONE owner, read by the cut AND by the trigger', () => {
    expect(filesWith(/\bceilingSkipRows\(/)).toEqual(['memory/tail-horizon.ts']);
    expect(filesWith(/\bmaxTrimUnits\(/)).toEqual(['memory/tail-horizon.ts']);
    const horizon = FILES.find((f) => f.rel === 'memory/tail-horizon.ts')!.code;
    expect(horizon.match(/ceilingSkipRows\(/g)?.length, 'declaration + the cut + the trigger').toBe(3);
    expect(horizon.match(/maxTrimUnits\(/g)?.length, 'declaration + the trim + the trigger').toBe(3);
  });
});

describe('t140 census — the continuity brief is gone', () => {
  it.each([
    'generateContinuityBrief',
    'CONTINUITY_BRIEF_PROMPT',
    'BRIEF_OVERWRITE_GUARD_MS',
    'BRIEF_TARGET_TOKENS',
    'skipContinuityBrief',
    "'lane.continuity'",
    '$.continuityBriefValidUntilTurn',
  ])('no shipped code says %s', (token) => {
    expect(filesWith(token)).toEqual([]);
  });

  it('nothing WRITES the brief keys any more: no json_set and no config assignment names them', () => {
    expect(filesWith(/json_set\([^)]*continuityBrief/)).toEqual([]);
    expect(filesWith(/\.continuityBrief(At|ValidUntilTurn)?\s*=/)).toEqual([]);
  });

  it('the only code still NAMING a brief key is the declared, handed-up remainder — counted both ways', () => {
    // Every file below is OUTSIDE t140's fence and named in the report's hand-up:
    //   * prompt/assembler.ts — `renderCompactionContinuity` reads `continuityBriefAt`; it can no
    //     longer render (nothing writes the key; migration 187 removes it), and deleting it needs
    //     `prompt/registry/entries.ts` + `types.ts`.
    //   * the five session-reset doors `json_remove` the key along with `scratchpad` — a no-op on
    //     a key nothing writes; removing the argument is a one-word edit in each, handed up.
    // A NEW reader or writer anywhere else reds this; so does the hand-up landing (good — then
    // this list shrinks with it).
    expect(filesWith('continuityBrief')).toEqual([
      'agent/tools/cat/session.ts',
      'gateway/routes/agents.ts',
      'gateway/routes/chat.ts',
      'gateway/routes/system.ts',
      'prompt/assembler.ts',
      'vault/maintenance.ts',
    ]);
  });
});

describe('t140 census — the 200K stand-in and the ceiling-only re-size are gone', () => {
  it('reassemble-for-fit no longer skips a pick for declaring no provider ceiling', () => {
    const fit = FILES.find((f) => f.rel === REFIT_REL)!.code;
    expect(fit).not.toMatch(/providerCeiling === null\) return null/);
    expect(fit).toMatch(/contextWindowPolicy\(getContextWindow\(modelId\), \{/);
  });

  it('no window resolution in the engine hard-codes 200000 as a fallback any more', () => {
    const model = FILES.find((f) => f.rel === 'agent/model.ts')!.code;
    expect(model).not.toMatch(/context_window \?\? 200000/);
    expect(model).not.toMatch(/return 200000;/);
    expect(model.match(/DEFAULT_CONTEXT_WINDOW = 200_000/g)?.length, 'one named default').toBe(1);
  });
});
