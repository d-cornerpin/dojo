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
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const callModel = vi.fn();
vi.mock('../../agent/model.js', () => ({
  callModel: (...args: unknown[]) => callModel(...args),
  getContextWindow: () => 128_000,
  getModelOutputCap: () => 4_096,
}));

import { generateSummary, truncateDeterministic } from '../summarize.js';

const RAW = [
  '[USER] here is a genuinely important business decision about the Verve deck',
  '[SOURCE: AGENT MESSAGE FROM maddy] and some peer traffic',
].join('\n\n---\n\n');

beforeEach(() => { callModel.mockReset(); });

// ════════ 1. the contract ════════

describe('generateSummary — the {ok:false, reason} contract (19 §1e)', () => {
  it('NO MODEL: refuses, and does NOT hand back the raw input as a summary', async () => {
    const r = await generateSummary({
      content: RAW, depth: 0, targetTokens: 50, agentId: 'kevin',
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
      content: RAW, depth: 0, targetTokens: 50, agentId: 'kevin', modelId: 'deepseek/x',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toMatch(/503|failed/i);
    expect(JSON.stringify(r)).not.toContain('Verve deck');
  });

  it('LEVEL 1: a normal summary is ok:true and is the model\'s text', async () => {
    callModel.mockResolvedValue({ content: 'a tidy summary' });
    const r = await generateSummary({
      content: RAW, depth: 0, targetTokens: 500, agentId: 'kevin', modelId: 'deepseek/x',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);
    expect(r.text).toBe('a tidy summary');
    expect(r.tokenCount).toBeGreaterThan(0);
  });

  it('LEVEL 3 truncation stays ok:true — it truncates the MODEL\'S OUTPUT, not raw rows', async () => {
    // Both calls return something far over target, so level 3 fires.
    callModel.mockResolvedValue({ content: 'model prose '.repeat(2_000) });
    const r = await generateSummary({
      content: RAW, depth: 0, targetTokens: 20, agentId: 'kevin', modelId: 'deepseek/x',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);
    expect(r.text).toContain('tokens truncated');
    expect(r.text).toContain('model prose');
    // and crucially it is NOT the raw input
    expect(r.text).not.toContain('Verve deck');
  });

  it('the truncation marker is unchanged — summary-rebuild detects it by substring', () => {
    // Research 06 §5's truncation-marker collision note: harmonising this marker with the
    // assembler's tool-result one would make every oversized tool result read as summariser
    // fallback and permanently block the nightly rebuild. It stays exactly as it is.
    const out = truncateDeterministic('x'.repeat(10_000), 100);
    expect(out).toMatch(/\[\.\.\. \d+ tokens truncated \.\.\.\]/);
  });
});

// ════════ 2. every caller honours it ════════

const SRC = (rel: string) => fs.readFileSync(path.join(process.cwd(), 'src/memory', rel), 'utf8');

describe('every generateSummary caller handles a refusal', () => {
  const CALLERS = ['compaction.ts', 'summary-rebuild.ts'];

  it('no caller reads .text without first proving .ok', () => {
    for (const f of CALLERS) {
      const src = SRC(f);
      // Every `await generateSummary({…})` must be followed, before the next call site, by
      // an `.ok` check. A caller that skipped it would compile only by asserting, and this
      // is what catches the assertion.
      const parts = src.split('await generateSummary(').slice(1);
      expect(parts.length, `${f} no longer calls generateSummary`).toBeGreaterThan(0);
      for (const [i, p] of parts.entries()) {
        const window = p.slice(0, 900);
        expect(window, `${f} call ${i + 1} does not check .ok`).toMatch(/\.ok\b/);
      }
    }
  });

  it('the refusal path never marks sources compacted', () => {
    // The whole point: a span we could not summarise must still be there next time.
    const src = SRC('compaction.ts');
    expect(src).toMatch(/SUMMARY_REFUSED/);
  });
});

// ════════ 3. contaminated summaries are impossible by construction ════════

describe('the write boundary is ONE filter, on both paths', () => {
  it('live compaction and the nightly replay share ONE input builder', () => {
    const comp = SRC('compaction.ts');
    const reb = SRC('summary-rebuild.ts');
    expect(comp).toMatch(/export function buildLeafSummaryInput/);
    expect(reb).toMatch(/buildLeafSummaryInput/);
    // and the replay does not keep a second copy of the transformation
    expect(reb).not.toMatch(/\.filter\(m => !isNonConversationForSummary\(m\.content\)\)/);
  });

  it('the nightly rebuild reports a CLEAN-STOCK count, so Sweep C can retire it at zero', () => {
    // A job that repairs forever needs a number that says when it can stop. Without this
    // the retirement decision would rest on "it looks quiet", which is the reasoning
    // roadmap #15 forbids.
    const reb = SRC('summary-rebuild.ts');
    expect(reb).toMatch(/SUMMARY_REBUILD_CLEAN_STOCK/);
    // and the counter is its own module — one owner per job, and the file being MEASURED
    // is not the one doing the measuring.
    expect(reb).toMatch(/from '\.\/summary-clean-stock\.js'/);
    expect(SRC('summary-clean-stock.ts')).toMatch(/export function recordCleanStock/);
  });
});
