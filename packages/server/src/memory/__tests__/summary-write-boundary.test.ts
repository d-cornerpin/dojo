// ════════════════════════════════════════════════════════════════════════════════════════
// THE SUMMARIZER'S WRITE BOUNDARY — PHASE-3 T5 Step 2.
// Research 06 §6's root fix, and 19 §1e's result contract.
//
// ── THE TWO MECHANISMS THIS REPLACES ────────────────────────────────────────────────────
// Research 06 §6 measured why `memory/summary-rebuild.ts` exists at all: summaries were
// contaminated because (a) live compaction predated the noise filter, so A2A envelopes, PM
// pokes and Dreamer scaffolding were folded in, and (b) **generateSummary's
// deterministic-truncation fallback stored RAW text verbatim**. Contaminated summaries get
// embedded and FTS-indexed, so they poison memory search, and condensation carries them
// into depth-1 and depth-2 parents. A nightly job then re-repairs them forever.
//
// Its own §6 root fix: "filter at the write boundary once … NEVER persist truncation-
// fallback body (write NO_CONVERSATION_PLACEHOLDER or leave uncompacted). Nightly scan then
// finds nothing BY CONSTRUCTION."
//
// (a) is closed by Step 1c: there is now ONE `buildLeafSummaryInput`, and both live
//     compaction and the nightly replay run through it. Clause group 1 pins that.
// (b) is closed here: `generateSummary` returns `{ok:false, reason}` on the two paths that
//     would have persisted RAW INPUT, and every caller leaves the span UNCOMPACTED.
//
// ── WHY "ok:false" AND NOT A PLACEHOLDER ON THOSE TWO PATHS ────────────────────────────
// A placeholder is a claim: "this span held no conversation". On the no-model and
// model-threw paths that claim is FALSE — the span may be the richest hour of the week and
// the summariser simply could not be reached. Writing a placeholder would mark the sources
// compacted and destroy that hour permanently. `{ok:false}` leaves the rows exactly where
// they are so the next drain tries again, which is the only honest answer to "I could not
// summarise this".
//
// The LEVEL-3 truncation is deliberately still `ok:true`: it truncates the MODEL'S OWN
// OUTPUT, which has already been through the summariser and carries no raw rows.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { runMigrations } from '../../db/migrations.js';

const callModel = vi.fn();
vi.mock('../../agent/model.js', () => ({
  callModel: (...args: unknown[]) => callModel(...args),
  getContextWindow: () => 128_000,
  getModelOutputCap: () => 4_096,
}));

import { generateSummary } from '../summarize.js';
import { FXID } from '../../../../../deploy/checks/fixture-vocabulary.mjs';

const RAW = [
  '[USER] here is a genuinely important business decision about the Verve deck',
  '[SOURCE: AGENT MESSAGE FROM maddy] and some peer traffic',
].join('\n\n---\n\n');

// `generateSummary` reads the `agents` table for the identity line. Until the suite
// got its own home (T74b) these cases were silently reading the DEVELOPER'S live
// database, where that table happens to exist — passing by accident on one machine.
// The schema is now made here rather than borrowed from whoever runs the tests.
beforeAll(() => { runMigrations(); });

beforeEach(() => { callModel.mockReset(); });

// ════════ 1. the contract ════════

describe('generateSummary — the {ok:false, reason} contract (19 §1e)', () => {
  it('NO MODEL: refuses, and does NOT hand back the raw input as a summary', async () => {
    const r = await generateSummary({
      content: RAW, depth: 0, targetTokens: 50, agentId: FXID.n4,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toMatch(/model/i);
    // the defect, stated as a clause: no field of the result may carry the input
    expect(JSON.stringify(r)).not.toContain('Verve deck');
  });

  it('MODEL THREW: refuses, and does NOT hand back the raw input as a summary', async () => {
    callModel.mockRejectedValue(new Error('provider 503'));
    const r = await generateSummary({
      content: RAW, depth: 0, targetTokens: 50, agentId: FXID.n4, modelId: 'deepseek/x',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toMatch(/503|failed/i);
    expect(JSON.stringify(r)).not.toContain('Verve deck');
  });

  it('LEVEL 1: a normal summary is ok:true and is the model\'s text', async () => {
    callModel.mockResolvedValue({ content: 'a tidy summary' });
    const r = await generateSummary({
      content: RAW, depth: 0, targetTokens: 500, agentId: FXID.n4, modelId: 'deepseek/x',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);
    expect(r.text).toBe('a tidy summary');
    expect(r.tokenCount).toBeGreaterThan(0);
  });

  // t269: levels 2 and 3 are gone. Level 2 re-summarised the SUMMARY ("cut ruthlessly") and level 3 cut
  // the middle out of it (`truncateDeterministic`; 10 stored notes carried its marker). An over-long
  // answer is now written once more from the source, and one still longer than its input is not kept.
  it('an answer far over its input is never truncated and never kept: the span is refused, rows kept', async () => {
    callModel.mockResolvedValue({ content: 'model prose '.repeat(2_000) });
    const r = await generateSummary({
      content: RAW, depth: 0, targetTokens: 20, agentId: FXID.n4, modelId: 'deepseek/x',
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('tokens truncated');
    expect(JSON.stringify(r)).not.toContain('Verve deck');
    // both calls read the SOURCE: neither is a summary of a summary
    for (const call of callModel.mock.calls) expect(JSON.stringify(call)).toContain('Verve deck');
  });
});
