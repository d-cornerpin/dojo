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
      // (round 2: the re-fit no longer predicts its leaving rows; it folds what its assembly
      // actually took out of view, through `assembleWithNothingOutOfViewUnsummarised`)
      // (t194: the gate reaches it through `leavingFromView`, which hands it the gauge's answer)
      'memory/compaction.ts',
      'memory/tail-horizon.ts',   // its own declaration
    ]);
    // And the gate APPLIES it: the routine condense is handed the leaving span, not a count.
    const gate = FILES.find((f) => f.rel === GATE_REL)!.code;
    expect(gate).toMatch(/const leaving = leavingFromView\(view\);/);
    expect(gate).toMatch(/condenseLeavingInBackground\(\{ agentId, writerModelId, dialedModelId, contextWindow, leaving \}\);/);
    expect(gate).toMatch(/checkAndCompact\(agentId, writerModelId, contextWindow, \{\s*leaving,/);
  });

  it('the trim bound has ONE owner, read by the cut AND by the trigger; t207: the row ceiling is gone', () => {
    expect(filesWith(/\bceilingSkipRows\(|TAIL_HORIZON_CEILING_MULTIPLE|ceilingLeadRows\(/)).toEqual([]);
    // t194: the "full" trigger is the gauge (`assembler.ts`'s dry run), so the trim bound's readers are
    // its declaration and the trim (tail-horizon) and the gauge's trigger (assembler) — still ONE law.
    expect(filesWith(/\bmaxTrimUnits\(/)).toEqual(['memory/assembler.ts', 'memory/tail-horizon.ts']);
    const horizon = FILES.find((f) => f.rel === 'memory/tail-horizon.ts')!.code;
    expect(horizon.match(/maxTrimUnits\(/g)?.length, 'declaration + the trim').toBe(2);
    const assembler = FILES.find((f) => f.rel === 'memory/assembler.ts')!.code;
    expect(assembler.match(/maxTrimUnits\(/g)?.length, 'the gauge\'s trigger').toBe(1);
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

  it('no code NAMES a brief key any more — the handed-up remainder landed at the v3.3.3 merge', () => {
    // prompt/assembler.ts's `renderCompactionContinuity` was the last reader of `continuityBriefAt`;
    // it could no longer render (nothing writes the key; migration 187 removes it) and was deleted
    // with its `prompt/registry/entries.ts` + `types.ts` entries at the merge. The five
    // session-reset doors that also `json_remove`d the key were fixed in fix round 1. A NEW reader
    // or writer anywhere reds this.
    expect(filesWith('continuityBrief')).toEqual([]);
  });

  it('fix round 1: the always-0 briefTokens field is gone from every shipped shape', () => {
    expect(filesWith(/\bbriefTokens\b/)).toEqual([]);
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

describe('t140 census, fix round 1 — one cost function, one launcher, every fallback re-fitted', () => {
  it('C1: "view full" prices the live tail with the token trim\'s own function, uncapped', () => {
    const compaction = FILES.find((f) => f.rel === 'memory/compaction.ts')!.code;
    const assembler = FILES.find((f) => f.rel === 'memory/assembler.ts')!.code;
    // The trim (budgetFreshTail) costs each row with storedRowCost, in its atoms …
    expect(assembler).toMatch(/const tokens = storedRowCost\(msg\);/);
    expect(assembler).toMatch(/function budgetFreshTail\([\s\S]*?const groups = groupTail\(messages\);/);
    // … and t194: the view-full measure IS that code — the gauge groups the very rows the lane budgets
    // (its pre-budget cap applied) with the trim's own function. `liveViewIsFull` and its copy are gone.
    expect(assembler).toMatch(/const groups = groupTail\(f\.before\);/);
    expect(compaction).not.toMatch(/liveViewIsFull|gateMessageCap|GATE_MESSAGE_CAP_TOKENS|storedRowCost/);
    // Exactly the files that own a tail cost call it: the owner and the trim (the dry run is the trim's).
    expect(filesWith(/\bstoredRowCost\(/)).toEqual(['memory/assembler.ts', 'memory/budget.ts']);
  });

  it('M3/I3 (round 2): ONE background PRESSURE-fold launcher, the gate\'s; ONE out-of-view door, used by the turn\'s assembly and the re-fit', () => {
    expect(filesWith(/\bcondenseLeavingInBackground\(/)).toEqual([GATE_REL]);
    // The re-fit's own background fold (fix round 1's M3) is gone: it folded above the floor only.
    expect(filesWith(/\bfoldWhatTheRefitSetAside\b/)).toEqual([]);
    expect(filesWith(/\bassembleWithNothingOutOfViewUnsummarised[<(]/)).toEqual([
      `${ENGINE_STEPS_REL}/assemble/index.ts`, REFIT_REL, 'memory/out-of-view-fold.ts',
    ]);
  });

  it('I1: every fallback pick is re-fitted, the fit filter judges windows, and the budget redirect re-fits', () => {
    const call = FILES.find((f) => f.rel === `${ENGINE_STEPS_REL}/call-llm/model-call.ts`)!.code;
    expect(call).toMatch(/reassembleForFitIfNeeded\(\{\s*agentId, modelId: fallback\.modelId,/);
    expect(call.match(/estimateAssembledArrayTokens\(systemPrompt, messages\), getContextWindow,/g)?.length,
      'all three fit-aware selections (first pick, rescue, unholdable-pick retry) pass the window resolver').toBe(3);
    expect(call).toMatch(/refitFor: async \(pick\) =>/);
    const selector = FILES.find((f) => f.rel === 'router/selector.ts')!.code;
    expect(selector).toMatch(/if \(windowOf && inputEstimate > Math\.floor\(CONTEXT_THRESHOLD \* windowOf\(modelId\)\)\) return false;/);
    // t149 F6: the wall's redirect moved out of model.ts to its own module, unchanged in this respect.
    const redirect = FILES.find((f) => f.rel === 'agent/budget-redirect.ts')!.code;
    expect(redirect).toMatch(/refit = params\.refitFor \? await params\.refitFor\(fb\.modelId\) : null;/);
  });
});

describe('t140 census, round 5 — the turn is measured against the model the router dials', () => {
  it('the "largest enabled routed row" window is gone; the turn builds against the router\'s opening picks', () => {
    expect(filesWith(/\broutedContextWindow\b/)).toEqual([]);
    expect(filesWith(/\bROUTED_TIERS\b/)).toEqual([]);
    const model = FILES.find((f) => f.rel === 'agent/model.ts')!.code;
    expect(model).toMatch(/if \(isAutoRouteSentinel\(modelId\)\) return routedOpeningWindow\(\);/);
    expect(model).toMatch(/for \(const id of routedFirstPicks\(\)\) \{/);
    // The opening picks are the selector's own: ONE standing-filter predicate, read by both.
    // Round 7: the opening picks read its reason, and count the skips that pass (rate limit, breaker).
    const selector = FILES.find((f) => f.rel === 'router/selector.ts')!.code;
    expect(selector.match(/passesStandingFilters\(/g)?.length, 'declaration + selectModel').toBe(2);
    expect(selector).toMatch(/const skip = standingSkip\(model, \['tools'\]\);\s*if \(skip === null \|\| PASSING\.has\(skip\)\) \{ picks\.add\(model\.model_id\); break walk; \}/);
    expect(selector).toMatch(/const PASSING = new Set<RoutedSkip>\(\['rate_limit', 'provider_down'\]\);/);
    // Its readers: the turn's building window, and the card's "can a model of its own hold it" (round 5 b).
    expect(filesWith(/\broutedFirstPicks\(/)).toEqual(['agent/model.ts', REFIT_REL, 'router/selector.ts']);
  });

  it('ONE routine check, measured for the dialed model: called by the gate for a model it knows and by the call step for the router\'s pick', () => {
    expect(filesWith(/\bcondenseForTheDialedModel\(/)).toEqual([REFIT_REL, GATE_REL]);
    const gate = FILES.find((f) => f.rel === GATE_REL)!.code;
    // The gate does not run it on an auto-routed iteration with nothing locked …
    expect(gate).toMatch(/if \(isAutoRouted && !lockedModelId\) \{\s*routineMeasuredAtGate\.delete\(agentId\);\s*return proceed\(state\);\s*\}\s*routineMeasuredAtGate\.set\(agentId, dialModelId\);/);
    // … and the call step runs it for the pick it is about to dial, unless the gate already did.
    const fit = FILES.find((f) => f.rel === REFIT_REL)!.code;
    expect(fit).toMatch(/if \(!gates\.routineCheckMeasuredAtGate\(input\.agentId, input\.modelId\)\) \{/);
    expect(fit).toMatch(/agentId: input\.agentId, dialedModelId: input\.modelId, contextWindow: getContextWindow\(input\.modelId\),/);
  });
});

describe('t140 census, round 5 — no fixed number cuts a working writer or caps what is leaving', () => {
  it.each([
    'ROUTINE_CONDENSE_WALL_CLOCK_MS', 'ROUTINE_CONDENSE_MAX_CHUNKS',
    'REPLACE_WALL_CLOCK_MS', 'REPLACE_MAX_PER_RUN',
    'OUT_OF_VIEW_FOLD_WALL_CLOCK_MS', 'OUT_OF_VIEW_FOLD_PER_WRITER_MS', 'OUT_OF_VIEW_FOLD_MAX_CHUNKS', 'OUT_OF_VIEW_FOLD_WRITER_TRIES',
    'LOCK_GRACE_MS', 'WRITER_COOLDOWN_MS', '__setOutOfViewFoldBoundsForTests',
  ])('no shipped code says %s', (token) => {
    expect(filesWith(token)).toEqual([]);
  });

  it('the turn\'s fold is bounded by the dialed model\'s own patience, and the background folds pass no cap and no clock', () => {
    const door = FILES.find((f) => f.rel === 'memory/out-of-view-fold.ts')!.code;
    expect(door).toMatch(/deadline: Date\.now\(\) \+ turnPatienceMs\(agentId, opts\.dialedModelId\)/);
    expect(door).toMatch(/\{ cause: 'out-of-view', throughSeq, rowsLeaving: owed \}, \{ abortSignal: bound\.signal \}\);/);
    expect(filesWith(/maxChunksPerRun/)).toEqual([]);   // round 6 (H3): the forced pass's cap went too
    const gate = FILES.find((f) => f.rel === GATE_REL)!.code;
    expect(gate).not.toMatch(/setTimeout\(/);
    const ph = FILES.find((f) => f.rel === 'memory/uncondensed-placeholder.ts')!.code;
    expect(ph).not.toMatch(/setTimeout\(/);
    expect(ph).toMatch(/for \(const writer of eligibleSummaryWriters\(preferred, agentId\)\) \{/);   // round 6: answering writers only; round 7: for this agent
  });
});

describe('t140 census, round 6 — writer health everywhere; a turn never waits on another compaction', () => {
  it('there is one list of writers anything may dial, and the background has no list of its own', () => {
    expect(filesWith(/\bbackgroundSummaryWriters\b/)).toEqual([]);
    expect(filesWith(/\bnoteAPersonSpoke\(/)).toEqual([GATE_REL, 'memory/summary-writer-health.ts']);
  });

  it('the turn\'s fold takes the lock only if it is free, and never awaits another holder', () => {
    const door = FILES.find((f) => f.rel === 'memory/out-of-view-fold.ts')!.code;
    expect(door).toMatch(/withLock\(`compact:\$\{agentId\}`[\s\S]*?\}, \{ ifBusy: 'skip' \}\)/);
    expect(door).not.toMatch(/ifBusy: 'wait'/);
    expect(door).not.toMatch(/await finished/);
  });
});

describe('t140 census, round 6 (H3) — the forced pass is bounded by the turn, not by numbers', () => {
  it.each(['FORCED_MAX_CHUNKS_PER_RUN', 'FORCED_WALL_CLOCK_MS', 'CONDENSE_MAX_CALLS_PER_RUN'])('no shipped code says %s', (token) => {
    expect(filesWith(token)).toEqual([]);
  });

  it('every forced pass is given the turn\'s patience for the model it is condensing for', () => {
    // t194: the gate's two emergency arms are DELETED (a full view is condensed, never surrendered), so
    // the boundary's live-conversation refusal is the one engine door that forces a pass on the turn.
    expect(filesWith(/\bforcedCompactionOptions\(/)).toEqual(['memory/assembly-validation.ts', 'memory/compaction-brakes.ts']);
    const val = FILES.find((f) => f.rel === 'memory/assembly-validation.ts')!.code;
    expect(val).toMatch(/\{ \.\.\.forcedCompactionOptions\(turnPatienceMs\(input\.agentId, input\.modelId\)\), dialedModelId: input\.modelId \}/);
    expect(filesWith(/\bturnPatienceMs\(/)).toEqual(['memory/assembly-validation.ts', 'memory/out-of-view-fold.ts', 'memory/turn-patience.ts']);
  });
});

describe('t140 census, round 6 (H2) — the router\'s own pick is passed over like a fallback', () => {
  // t212: the pass-over moved with the routing, ahead of the build (`call-llm/model-selection.ts`, called
  // by `assemble`): a refused pick is passed over before anything is assembled for it.
  it('the router\'s pick is checked before it is built for, and the router is asked for the next, excluding refused picks', () => {
    const sel = FILES.find((f) => f.rel === `${ENGINE_STEPS_REL}/call-llm/model-selection.ts`)!.code;
    expect(sel).toMatch(/for \(let refusal = await refusalFor\(agentId, modelId, toolPayloadTokens, turnContext\); refusal;/);
    expect(sel).toMatch(/const next = selector\.selectModel\(routerTier, agentId, excludedModels, \['tools'\]\);/);
    const step = FILES.find((f) => f.rel === `${ENGINE_STEPS_REL}/call-llm/index.ts`)!.code;
    expect(step).toMatch(/agentId, modelId: pick, messages, systemPrompt, volatileFrom, assemblyTurnContext, anotherPickMayFollow: isAutoRouted,/);
    expect(step).toMatch(/const called = await callWithRetryAndFallback\(state, pick, \{/);
  });
});

describe('t140 census, round 7 — the change signals that re-arm a failed writer', () => {
  it('a person\'s fresh message re-arms for THAT agent; a SUMMARY answer re-arms it (t207: no chat answer does); nothing else does', () => {
    const gate = FILES.find((f) => f.rel === GATE_REL)!.code;
    expect(gate).toMatch(/if \(state\.loopCount === 1 && state\.lastUserMessageId\) noteAPersonSpoke\(agentId\);/);
    expect(filesWith(/\bnoteAPersonSpoke\(/)).toEqual([GATE_REL, 'memory/summary-writer-health.ts']);
    expect(filesWith(/\bnoteProviderAnswered\b/), 'no "any call answered" door is left').toEqual([]);
    const health = FILES.find((f) => f.rel === 'memory/summary-writer-health.ts')!.code;
    expect(health, 't207: the in-process map of marks is gone; the mark is a persisted row').not.toMatch(/notAnsweringSince/);
  });
});

describe('t140 census, round 7 — no turn cancels a background summary', () => {
  it('the preemptible-compaction registry and its abort reason are gone from shipped code; the gate\'s background fold carries no abort', () => {
    expect(filesWith(/\b(preemptBackgroundCompaction|registerBackgroundCompaction|releaseBackgroundCompaction|FOLD_PREEMPTED)\b/)).toEqual([]);
    const gate = FILES.find((f) => f.rel === GATE_REL)!.code;
    const launch = gate.slice(gate.indexOf('function condenseLeavingInBackground('));
    expect(launch.slice(0, launch.indexOf('\n}\n'))).not.toMatch(/AbortController|abortSignal/);
  });
});

describe('t140 census, round 7 — when no router pick holds the agent, the owner is told why and the turn ends', () => {
  it('the routing ends the turn with the owner notice, never a throw into the injury cascade', () => {
    // t212: the routing runs in `assemble`, ahead of the build; the notice is said there and the step asks to exit.
    const sel = FILES.find((f) => f.rel === `${ENGINE_STEPS_REL}/call-llm/model-selection.ts`)!.code;
    const branch = sel.slice(sel.indexOf('if (!next) {'));
    const body = branch.slice(0, branch.indexOf('\n      }\n'));
    expect(body).toMatch(/const said = await tellOwnerNoPickHolds\(\{[^}]*\}\);\s*return \{ state, said \};/);
    expect(body, "the refusal is not rethrown").not.toMatch(/\bthrow\b/);
    const asm = FILES.find((f) => f.rel === `${ENGINE_STEPS_REL}/assemble/index.ts`)!.code;
    expect(asm).toMatch(/if \(routed\.said !== undefined\) return requestExit\(state, routed\.said\)/);
    expect(filesWith(/\btellOwnerNoPickHolds\(/)).toEqual([`${ENGINE_STEPS_REL}/call-llm/model-selection.ts`, `${ENGINE_STEPS_REL}/call-llm/no-pick-holds.ts`]);
  });
});
