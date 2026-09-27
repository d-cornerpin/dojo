// ════════════════════════════════════════════════════════════════════════════════════════
// LANE-3 — THE LEDGER TELLS AN ENGINE UTILITY DIAL FROM A REAL AGENT TURN.
//
// ── THE DEFECT, AND WHAT IT COST TWICE ──
// `cost_records.request_type` is the only field that says WHAT a model call was, and three of the
// four `recordCost` sites in `agent/model.ts` wrote the turn's label for every call that reached
// them:
//
//     callOllamaModel        requestType: routerTier ?? 'ollama'
//     callOpenAIModel        requestType: routerTier ?? 'agent_turn'      ← the dev box's own path
//     callAnthropicSdkModel  requestType: routerTier ?? 'agent-sdk'
//     dialModel              requestType: routerTier ?? (tools ? 'agent_turn' : 'completion')  ← right
//
// But the platform dials a model for fourteen other reasons, and every one of them passes
// `tools: false`: the router's probe, the multistep classifier, briefing, retrieval, summarize
// (twice), the canvas and browser vision reads, the web-fetch extract, vault extraction, the
// technique share-export, ask-title, the voice turn and the healer's own read. On the
// OpenAI-compatible path — which is what the declared floor model runs on — all of them landed in
// the ledger as `agent_turn`, indistinguishable from a real turn. A consumer asking "how big is a
// turn on this box" got probe rows in the answer and had to fall back to size heuristics to guess
// which rows were real; that happened twice.
//
// ── THE FIX IS THE SIBLING'S OWN EXPRESSION, NOT A NEW IDEA ──
// `dialModel` already had it right. The other three now read the same way, so the rule is one
// sentence: A DIAL THAT SHIPS NO TOOLS ARRAY IS NOT AN AGENT TURN. `'completion'` is deliberately
// the existing word rather than a new one — `report/telemetry-whitelist.ts:154-157` already
// declares it a member of this column's domain ("this list is its only domain", and the set is
// MEASURED), so no reader meets a string it does not know, and the four rows that mean "a real
// turn" keep the labels they have always had.
//
// ── WHY THIS SUITE READS THE SOURCE AND EVALUATES IT ──
// The property is a property of an EXPRESSION, not of a function this suite could call:
// `recordCost` takes `requestType` as a parameter, so a unit test that drove it would only prove
// that the ledger stores what it is handed. `agent/model.ts` cannot be imported here either (its
// module graph starts a platform). So each `requestType:` expression is extracted from the source
// and EVALUATED under both conditions, which is stronger than a grep and covers a site added
// tomorrow for free.
//
// ── THE RESIDUAL, NAMED RATHER THAN GLOSSED ──
// `tools` is a sound discriminator for every utility dial this tree has (all fourteen pass
// `tools: false`, asserted below), but it is a PROXY: a utility dial that wanted tools would still
// be labelled a turn. The honest end state is an explicit purpose on `ModelCallParams` carried into
// a `call_purpose` column, which needs ratchet raises on three files this lane may not touch; the
// lane report argues that raise. What this clause pins is that no site may go back to labelling a
// toolless dial a turn.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../../..');
const MODEL_TS = path.join(REPO_ROOT, 'packages/server/src/agent/model.ts');

/** Every `requestType:` expression handed to a `recordCost` call in `agent/model.ts`. */
function requestTypeExpressions(): string[] {
  const src = fs.readFileSync(MODEL_TS, 'utf-8');
  return [...src.matchAll(/requestType:\s*(.+?),\n/g)].map((m) => m[1].trim());
}

/** What that expression evaluates to for a given (routerTier, tools) — the two inputs it reads. */
function evaluate(expr: string, routerTier: string | undefined, tools: boolean): unknown {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  return new Function('routerTier', 'tools', `return (${expr});`)(routerTier, tools);
}

/** The labels that mean "this row was a real agent turn". */
const TURN_LABELS = new Set(['agent_turn', 'ollama', 'agent-sdk']);

describe('LANE-3 — the ledger is being asked about something', () => {
  it('every recordCost site in model.ts was found, and there are at least four', () => {
    const exprs = requestTypeExpressions();
    expect(exprs.length, `no requestType: expressions found in ${MODEL_TS} — the extraction anchor `
      + 'changed and every clause below would pass on an empty list').toBeGreaterThanOrEqual(4);
    // Each one must be evaluable with the two inputs it is allowed to read. A site that started
    // reading a third thing is a finding here rather than a silent skip.
    for (const expr of exprs) {
      expect(() => evaluate(expr, undefined, true), `not evaluable from (routerTier, tools): ${expr}`).not.toThrow();
    }
  });
});

describe('LANE-3 — a toolless dial is never recorded as an agent turn', () => {
  it('RED-CRITICAL: with no router tier and no tools, no site writes a turn label', () => {
    for (const expr of requestTypeExpressions()) {
      const value = evaluate(expr, undefined, false);
      expect(
        TURN_LABELS.has(String(value)),
        `\`${expr}\` records ${JSON.stringify(value)} for an engine utility dial (tools:false). `
        + 'That is a turn label, so probe/classifier/summarizer spend is indistinguishable from a '
        + 'real turn in cost_records — the defect this clause exists for. Mirror dialModel: '
        + "routerTier ?? (tools ? '<turn label>' : 'completion').",
      ).toBe(false);
      expect(value, `\`${expr}\` should record the ledger's existing word for a non-turn dial`).toBe('completion');
    }
  });

  it('a real turn keeps the label it has always had', () => {
    const labels = requestTypeExpressions().map((e) => String(evaluate(e, undefined, true)));
    // Every site must still name a turn when tools ride, and the three transports keep their own
    // word — this is what stops the fix being "label everything completion".
    for (const label of labels) expect(TURN_LABELS.has(label), `turn label lost: ${label}`).toBe(true);
    expect(new Set(labels)).toEqual(new Set(['agent_turn', 'ollama', 'agent-sdk']));
  });

  it('a router tier still wins over both — the router decision is the truth about that call', () => {
    for (const expr of requestTypeExpressions()) {
      expect(evaluate(expr, 'budget_fallback', false)).toBe('budget_fallback');
      expect(evaluate(expr, 'light', true)).toBe('light');
    }
  });
});

describe('LANE-3 — the premise the proxy rests on', () => {
  it('every engine utility dial in the tree passes tools: false', () => {
    // If a utility caller ever stops passing it, `tools` stops being a sound discriminator and the
    // explicit-purpose design the report argues for becomes required rather than preferable.
    const callers = [
      'router/probe.ts', 'agent/v2/classifiers/multistep.ts', 'memory/briefing.ts',
      'memory/retrieval.ts', 'memory/summarize.ts', 'agent/canvas-view.ts', 'agent/browser.ts',
      'vault/extraction.ts', 'techniques/share-export.ts', 'work/ask-title.ts', 'voice/voice-ws.ts',
      'agent/runtime.ts',
    ];
    for (const rel of callers) {
      const src = fs.readFileSync(path.join(REPO_ROOT, 'packages/server/src', rel), 'utf-8');
      expect(src, `${rel} calls the model but no longer passes tools: false`).toMatch(/tools:\s*false/);
    }
  });

  it("'completion' is already a declared member of the column's domain", () => {
    // The whitelist is that column's only domain (its own comment), so a value outside it renders
    // `<unrecognised>` in a report. This is why the fix reuses the existing word.
    const wl = fs.readFileSync(path.join(REPO_ROOT, 'packages/server/src/report/telemetry-whitelist.ts'), 'utf-8');
    const block = /call\.request_type[\s\S]*?\]\s*\}/.exec(wl)?.[0] ?? '';
    for (const member of ['agent_turn', 'ollama', 'agent-sdk', 'completion']) {
      expect(block, `the request_type domain no longer declares ${member}`).toContain(member);
    }
  });
});
