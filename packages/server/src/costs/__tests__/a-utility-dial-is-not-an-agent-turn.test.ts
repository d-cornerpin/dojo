// ════════════════════════════════════════════════════════════════════════════════════════
// THE LEDGER TELLS AN ENGINE UTILITY DIAL FROM A REAL AGENT TURN — BY DECLARATION.
//
// ── THE DEFECT, AND WHAT IT COST TWICE ──
// `cost_records.request_type` is the only field that says WHAT a model call was, and three of the
// four `recordCost` sites in `agent/model.ts` stamped the turn's label on everything that reached
// them (`routerTier ?? 'agent_turn'` on the OpenAI-compatible path, which is what the declared floor
// model runs on). The platform dials a model for fourteen other reasons — the router probe, the
// multistep classifier, briefing, retrieval, summarize ×2, the canvas/browser/system-control vision
// reads, the web-fetch extract, vault extraction, the technique share-export, ask-title, the voice
// fast-opener and the runtime's image captioner — and every one of them landed as `agent_turn`. A
// consumer asking "how big is a turn on this box" got probe rows in the answer and fell back to size
// heuristics to guess which rows were real. That happened twice.
//
// ── AND THE FIRST FIX WAS WRONG IN THE OTHER DIRECTION (review C, L3-F1) ──
// The first pass keyed the label on the `tools` flag — `routerTier ?? (tools ? 'agent_turn' :
// 'completion')`. That reads the CARGO and calls it the KIND, and the two come apart at exactly one
// place: `agent/runtime.ts`'s capability gate sets `useTools = false` for a REAL, user-facing turn
// whenever the model lacks the tools capability ("This model can't use tools, the agent will reply
// with text only"), and `v2/steps/call-llm/model-call.ts` passes that value straight through. So on
// such a box EVERY turn recorded `completion` and NO row said `agent_turn` at all — the same
// consumer question answered wrongly, one direction over. The suite could not see it, because it
// asserted "at tools:false, no site writes a turn label", which is precisely the wrong assertion for
// a real turn that ships no schemas.
//
// ── WHAT IT KEYS ON NOW: A DECLARATION, MADE WHERE THE TRUTH IS KNOWN ──
// `ModelCallParams.purpose` is declared by the ONE dial that is a served agent turn
// (`model-call.ts`), and every recordCost site reads `routerTier ?? purpose ?? 'completion'`. The
// call site is the only place that knows what the call IS; a transport cannot infer it, and neither
// can its cargo. Three consequences, all asserted below: a toolless TURN is still a turn; an
// undeclared dial is a `completion` on every transport; and a router tier still wins over both,
// because the router's decision is the truth about that particular call.
//
// `'completion'` is deliberately the EXISTING word — `report/telemetry-whitelist.ts` already declares
// it in this column's only domain, and that domain is MEASURED — so no reader meets a novel string.
// The transport words `'ollama'` and `'agent-sdk'` are gone from this column ON PURPOSE: they named
// the pipe, not the purpose, and the pipe is already in `provider_id`. Historical rows keep them and
// the whitelist keeps them as members, so old data stays readable.
//
// ── WHY THIS SUITE READS THE SOURCE AND EVALUATES IT ──
// The property belongs to an EXPRESSION, not to a function this suite could call: `recordCost` takes
// `requestType` as a parameter, so driving it would only prove the ledger stores what it is handed,
// and `agent/model.ts` cannot be imported here (its module graph starts a platform). So each
// `requestType:` expression is extracted from the source and EVALUATED under every combination that
// matters — which is stronger than a grep and covers a site added tomorrow for free.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../../..');
const MODEL_TS = path.join(REPO_ROOT, 'packages/server/src/agent/model.ts');
const TURN_DIAL = path.join(REPO_ROOT, 'packages/server/src/agent/v2/steps/call-llm/model-call.ts');

/** Every `requestType:` expression handed to a `recordCost` call in `agent/model.ts`. */
function requestTypeExpressions(): string[] {
  const src = fs.readFileSync(MODEL_TS, 'utf-8');
  return [...src.matchAll(/requestType:\s*(.+?),\n/g)].map((m) => m[1].trim());
}

/** What the expression evaluates to for a given (routerTier, purpose, tools). `tools` is passed so a
 *  site that goes BACK to reading the cargo is still evaluable — and still caught. */
function evaluate(expr: string, routerTier: string | undefined, purpose: string | undefined, tools: boolean): unknown {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  return new Function('routerTier', 'purpose', 'tools', `return (${expr});`)(routerTier, purpose, tools);
}

/** The label a served agent turn must carry, and the one an undeclared dial must carry. */
const TURN = 'agent_turn';
const UTILITY = 'completion';
/** Words that have ever meant "a real turn" in this column — none may be written for a utility dial. */
const TURN_LABELS = new Set([TURN, 'ollama', 'agent-sdk']);

describe('the ledger is being asked about something', () => {
  it('every recordCost site in model.ts was found, and there are at least four', () => {
    const exprs = requestTypeExpressions();
    expect(exprs.length, `no requestType: expressions found in ${MODEL_TS} — the extraction anchor `
      + 'changed and every clause below would pass on an empty list').toBeGreaterThanOrEqual(4);
    for (const expr of exprs) {
      expect(() => evaluate(expr, undefined, TURN, true), `not evaluable from (routerTier, purpose, tools): ${expr}`).not.toThrow();
    }
  });
});

describe('a served agent turn is recorded as a turn — with or without tools', () => {
  it('RED-CRITICAL: the NON-TOOL-CAPABLE BOX — a declared turn that ships no tools is still a turn', () => {
    // L3-F1, the measured shape: `runtime.ts`'s capability gate hands `tools:false` to a real turn,
    // so this combination IS a live production state, not a hypothetical. Before the declaration
    // every site answered 'completion' here and no row on such a box said `agent_turn` at all.
    for (const expr of requestTypeExpressions()) {
      expect(
        evaluate(expr, undefined, TURN, false),
        `\`${expr}\` records "${String(evaluate(expr, undefined, TURN, false))}" for a REAL agent turn `
        + 'on a model without the tools capability. On that box no row says agent_turn at all, which is '
        + 'the consumer question this file exists for, answered wrongly in the other direction. The kind '
        + 'must read the DECLARATION (`purpose`), never the cargo (`tools`).',
      ).toBe(TURN);
    }
  });

  it('a declared turn WITH tools is a turn too — the ordinary box', () => {
    for (const expr of requestTypeExpressions()) {
      expect(evaluate(expr, undefined, TURN, true)).toBe(TURN);
    }
  });

  it('the turn dial is the ONE site that declares the purpose, and it declares this one', () => {
    const src = fs.readFileSync(TURN_DIAL, 'utf-8');
    expect(src, `${TURN_DIAL} no longer declares purpose: 'agent_turn' — the only served-turn dial `
      + 'stopped saying what it is, so every row on every box becomes a completion')
      .toMatch(/purpose:\s*'agent_turn'/);
  });
});

describe('an engine utility dial is never recorded as a turn', () => {
  it('RED-CRITICAL: an UNDECLARED dial writes the utility word, tools or no tools', () => {
    for (const expr of requestTypeExpressions()) {
      for (const tools of [false, true]) {
        const value = String(evaluate(expr, undefined, undefined, tools));
        expect(
          TURN_LABELS.has(value),
          `\`${expr}\` records ${JSON.stringify(value)} for an undeclared (engine utility) dial at `
          + `tools:${tools}. Probe/classifier/summarizer spend then reads as a real turn in `
          + 'cost_records, which is the original defect.',
        ).toBe(false);
        expect(value, `\`${expr}\` should record the ledger's existing word for a non-turn dial`).toBe(UTILITY);
      }
    }
  });

  it('a router tier still wins over both — the router decision is the truth about that call', () => {
    for (const expr of requestTypeExpressions()) {
      expect(evaluate(expr, 'budget_fallback', undefined, false)).toBe('budget_fallback');
      expect(evaluate(expr, 'light', TURN, true)).toBe('light');
    }
  });

  it('no site reads the `tools` flag any more — the cargo cannot decide the kind', () => {
    // The structural half of L3-F1: an expression that mentions `tools` has gone back to inferring.
    for (const expr of requestTypeExpressions()) {
      expect(expr, `\`${expr}\` reads the tools flag; that is what mislabelled every turn on a `
        + 'non-tool-capable model').not.toMatch(/\btools\b/);
    }
  });
});

describe('the premise: exactly one dial declares a purpose', () => {
  it('all FOURTEEN engine utility dials stay undeclared', () => {
    // L3-F3: the first version of this clause named twelve. `system-control.ts` and `web-tools.ts`
    // were the two it missed, and the count is asserted so a fifteenth dial cannot appear unpinned.
    const callers = [
      'agent/browser.ts', 'agent/canvas-view.ts', 'agent/runtime.ts', 'agent/system-control.ts',
      'agent/v2/classifiers/multistep.ts', 'agent/web-tools.ts', 'memory/briefing.ts',
      'memory/retrieval.ts', 'memory/summarize.ts', 'router/probe.ts', 'techniques/share-export.ts',
      'vault/extraction.ts', 'voice/voice-ws.ts', 'work/ask-title.ts',
    ];
    expect(callers.length).toBe(14);
    for (const rel of callers) {
      const src = fs.readFileSync(path.join(REPO_ROOT, 'packages/server/src', rel), 'utf-8');
      expect(src, `${rel} is expected to be an engine utility dial but no longer passes tools: false`)
        .toMatch(/tools:\s*false/);
      expect(src, `${rel} now declares a purpose — if it became a served turn that is a real change, `
        + 'and this clause is where it is argued rather than discovered')
        .not.toMatch(/purpose:\s*'/);
    }
  });

  it("'completion' and 'agent_turn' are both declared members of the column's domain", () => {
    const wl = fs.readFileSync(path.join(REPO_ROOT, 'packages/server/src/report/telemetry-whitelist.ts'), 'utf-8');
    const block = /call\.request_type[\s\S]*?\]\s*\}/.exec(wl)?.[0] ?? '';
    // The two words in use, plus the two transport words history still carries.
    for (const member of [TURN, UTILITY, 'ollama', 'agent-sdk']) {
      expect(block, `the request_type domain no longer declares ${member}`).toContain(member);
    }
  });
});
