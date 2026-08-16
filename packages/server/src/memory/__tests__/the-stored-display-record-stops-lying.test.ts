// ════════════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR T5 — the stored display record stops lying (issue 5).
//
// THE DEFECT, as measured rather than as reported. The 2026-08-09 UX review reported a red
// error chip and "5-7 bookkeeping badges per answer" on screen. Neither rendered. The review
// runner inferred both from `messages.display_tier`, a column NO renderer reads
// (`grep -rn "display_tier\|displayTier" packages/dashboard/src` -> 0 hits, re-run at this
// commit and asserted below). What is REAL is the inverse: the stored column says
// `user-visible` for rows that draw nothing, because the tier was a row-level fact
// (`visibility.ts`: any assistant row of tool_use JSON is user-visible, full stop) while the
// substantive/bookkeeping line is drawn PER BLOCK, client-side, by the shared `classifyTool`.
// One row, two rules, two different answers. Every machine reader that trusts the column
// over-reports what the user saw — which is exactly how the review produced two phantoms.
//
// THE FIX UNDER TEST: the write-time tier folds the SAME shared `classifyTool` through the
// SAME `toolBadgeTier` the render rule uses. A tool-turn row whose blocks are ALL
// bookkeeping-class stamps `agent-only`; one non-bookkeeping block keeps it `user-visible`.
// No second copy of the rule is created, and nothing about SERVING changes — the recorded
// refusal at `gateway/routes/chat.ts:305-310` (tier must never become a WHERE clause) is
// untouched and is asserted untouched below.
//
// WHY RENDERING CANNOT MOVE, stated so the next reader does not have to re-derive it. In
// regular mode an all-bookkeeping tool-turn row already renders NOTHING: `Chat.tsx:585`
// drops every bookkeeping block, `ToolBadgeGroup` returns null on an empty set
// (`ToolBadge.tsx:153`), and the pill-grouping walk classifies the same row `'hidden'` and
// skips it, so it is never a group leader and never carries another row's chips. After this
// change the row is dropped one step earlier, by the tier check at `Chat.tsx:1870`. Same
// pixels, one honest column.
//
// THE FIXTURES ARE THE REAL ROWS. Every block array below is the verbatim stored content of
// the S1 scenario's own rows on the worn-in dev box (`~/.dojo/data/dojo.db`, seq 58421-58431),
// with long string arguments elided at 57 chars. These are the rows the UX review looked at.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyMessageForDisplay, classifyTool, toolBadgeTier } from '@dojo/shared';
import { SUB_AGENT_ALWAYS_LOADED, PRIMARY_AGENT_ALWAYS_LOADED } from '../../tools/tool-docs.js';
import { toolDefinitions } from '../../agent/tools/definitions.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

const row = (blocks: unknown[]) => ({
  role: 'assistant' as const,
  lane: 'owner' as const,
  content: JSON.stringify(blocks),
});

const tool = (name: string, input: Record<string, unknown> = {}) =>
  ({ type: 'tool_use', id: `call_${name}`, name, input });

// ── S1's six tool-bearing rows, as stored ──
const S1 = {
  58421: [tool('load_tool_docs', { tools: ['web_search', 'web_fetch'] }), tool('work_update', { action: 'list' })],
  58423: [tool('work_update', { action: 'status', status: 'in_progress', task_id: 'placeholder' })],
  58425: [tool('load_tool_docs', { tools: ['work_open', 'work_note'] }),
          tool('web_search', { query: 'best note-taking apps 2026 comparison', count: 8 }),
          tool('web_search', { query: 'best note-taking app 2026 fast reliable search', count: 8 })],
  58427: [tool('work_open', { kind: 'task', title: 'Research note-taking apps for David' }),
          tool('web_fetch', { url: 'https://www.pcmag.com/picks/the-best-note-taking-apps' }),
          tool('web_fetch', { url: 'https://zapier.com/blog/best-note-taking-apps/' })],
  58429: [tool('web_fetch', { url: 'https://unstar.app/blog/ranked-2026' }),
          tool('web_fetch', { url: 'https://toolradar.com/guides/best-note-taking-apps' })],
  58431: [tool('work_update', { action: 'status', status: 'complete', task_id: '11985f2e-b8b7-40df-a510-9512efc4c44b' })],
};

// The client's REAL regular-mode chip filter, transcribed as one expression.
//
// UPDATED BY UX-REPAIR T54(d) (2026-08-16, owner ruling 6). This used to read
// `classifyTool(b.name)` and carried the note "all four dashboard call sites are arg-less, so
// the render rule never sees a tool's arguments and neither may the stored tier." That is no
// longer true and the change was the point of T54(d): the four client sites now pass
// `b.input`, and so does the write-time fold, which makes `WORK_OP_DISPLAY_CLASS`'s
// `work_open:reminder` promotion reachable instead of recorded-and-dead. T5's rule is
// untouched — one classifier, one fold, one answer — only its inputs are complete. The
// equivalence below is what actually matters and it is re-asserted with reminder, shell and
// canvas cases added, so neither side can be edited apart.
const chipsTheClientWouldDraw = (blocks: Array<{ type: string; name?: string; input?: Record<string, unknown> }>) =>
  blocks.filter((b) => b.type === 'tool_use' && b.name && classifyTool(b.name, b.input) !== 'bookkeeping');

describe('T5 — the stored tier tells the truth about a tool-turn row', () => {
  it('THE RED: S1 58421/58423/58431 are all bookkeeping and stamp agent-only', () => {
    // Before the fix all three read `user-visible` while drawing nothing on screen.
    for (const seq of [58421, 58423, 58431] as const) {
      const got = classifyMessageForDisplay(row(S1[seq]));
      expect(got.tier, `seq ${seq}`).toBe('agent-only');
      expect(chipsTheClientWouldDraw(S1[seq] as never), `seq ${seq} draws no chip`).toHaveLength(0);
    }
  });

  it('CONTROL: a row with any non-bookkeeping block stays user-visible', () => {
    for (const seq of [58425, 58427, 58429] as const) {
      const got = classifyMessageForDisplay(row(S1[seq]));
      expect(got.tier, `seq ${seq}`).toBe('user-visible');
      expect(chipsTheClientWouldDraw(S1[seq] as never).length, `seq ${seq} draws chips`).toBeGreaterThan(0);
    }
  });

  it('CONTROL: the KIND is untouched — every one of the six still classifies tool-turn', () => {
    // message-store reads BOTH `.kind` and `.tier` off this classifier
    // (`m.displayKind ?? display.kind`, unchanged since 2f54de3). This fix moves the tier
    // only; if the kind moved, the demotion and the sixth narrowing would silently change.
    for (const seq of [58421, 58423, 58425, 58427, 58429, 58431] as const) {
      expect(classifyMessageForDisplay(row(S1[seq])).kind, `seq ${seq}`).toBe('tool-turn');
    }
  });

  it('THE ANTI-DRIFT PROPERTY: stored tier === "the client would draw at least one chip"', () => {
    // This is the whole point of the task stated as one equivalence. It holds by
    // construction (both sides call the same `classifyTool` with the same arguments), and
    // this asserts it so a future edit to either side cannot re-open the gap the UX review
    // fell into. The last four cases are UX-REPAIR T54's four rulings run through the SAME
    // equivalence: each one moved the drawn answer and the stored answer together, which is
    // the only way any of them was allowed to move.
    const cases: Array<Array<{ type: string; name?: string; input?: Record<string, unknown> }>> = [
      ...Object.values(S1) as never,
      [tool('work_update', { action: 'list' })],
      [tool('web_search', { query: 'x' })],
      [tool('exec', { cmd: 'ls' })],
      [tool('show_to_user', {})],
      [tool('load_tool_docs', {}), tool('list_agents', {}), tool('vault_search', {})],
      [tool('load_tool_docs', {}), tool('exec', { cmd: 'ls' })],
      // T54(d): the promotion, and its own control one line down.
      [tool('work_open', { kind: 'reminder', what: 'call mum', when: '2026-08-17T09:00' })],
      [tool('work_open', { kind: 'task', title: 'Research note-taking apps' })],
      // T54(a)/(b)/(c): shell beside its sibling, and the two right-dock view surfaces.
      [tool('shell', { script: 'ls ~/notes | wc -l' })],
      [tool('canvas_render', { path: '/x/report.md' }), tool('open_browser', { url: 'https://example.com' })],
    ];
    for (const blocks of cases) {
      const tier = classifyMessageForDisplay(row(blocks)).tier;
      const draws = chipsTheClientWouldDraw(blocks).length > 0;
      expect(tier === 'user-visible', JSON.stringify(blocks.map((b) => b.name))).toBe(draws);
    }
  });

  it('the fold is `toolBadgeTier` itself — no second copy of the rule exists', () => {
    // Solve step 4: `toolBadgeTier` had ZERO callers and was dead code. It is now the one
    // block->tier helper the write side folds through, so the render rule and the stored
    // rule cannot be edited apart.
    expect(toolBadgeTier(classifyTool('work_update'))).toBe('agent-only');
    expect(toolBadgeTier(classifyTool('web_search'))).toBe('user-visible');
    const src = fs.readFileSync(path.join(REPO, 'packages/shared/src/visibility.ts'), 'utf8');
    const callers = src.split('\n').filter((l) => l.includes('toolBadgeTier(') && !l.includes('export function'));
    expect(callers.length, 'toolBadgeTier is called by the write-side fold').toBeGreaterThan(0);
  });

  it('a row that is NOT purely tool_use blocks is left alone', () => {
    // "ALL bookkeeping" means every block. A text block, an image, a thinking block — any of
    // them means the row carries something the chip filter does not govern, so the tier must
    // not be decided by the tools alone. Measured on the dev box: 0 of 8,626 stored
    // assistant tool rows carry a text block today, so this is a guard, not a live path.
    const mixed = [{ type: 'text', text: 'Let me check the board.' }, tool('work_update', { action: 'list' })];
    expect(classifyMessageForDisplay(row(mixed)).tier).toBe('user-visible');
  });

  it('UNTOUCHED: the dashboard still reads the stored column NOWHERE', () => {
    // The premise correction of the whole issue. If this ever goes non-zero, the column has
    // acquired a renderer and every claim in this file has to be re-derived.
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && /display_tier|displayTier/.test(fs.readFileSync(p, 'utf8'))) hits.push(p);
      }
    };
    walk(path.join(REPO, 'packages/dashboard/src'));
    expect(hits).toEqual([]);
  });

  it('UNTOUCHED: serving is still not filtered by tier (the recorded refusal)', () => {
    const src = fs.readFileSync(path.join(REPO, 'packages/server/src/gateway/routes/chat.ts'), 'utf8');
    expect(src).toContain('display_tier` does NOT become a WHERE');
    expect(/WHERE[\s\S]{0,400}display_tier\s*=/.test(src)).toBe(false);
  });
});

describe('T5 — the always-loaded asymmetry that invented a task id', () => {
  it('THE RED: a sub-agent carries work_open, not just work_update', () => {
    // S1's model called `work_update(action="list")`, was told "No active tasks", and then
    // called `work_update(status=...)` with `task_id:"placeholder"` — it reached for the
    // loaded tool and fabricated the id the schema demanded. Its own thinking names the
    // cause: "work_open isn't in my always-loaded list but it IS listed under Work Tracker".
    expect(SUB_AGENT_ALWAYS_LOADED).toContain('work_open');
    expect(SUB_AGENT_ALWAYS_LOADED).toContain('work_update');
  });

  it('the sub-agent list stops being the odd one out', () => {
    // The list header's own argument: "a load_tool_docs round-trip is the friction that makes
    // a weak model skip the tracker entirely." Both verbs are one call away for the primary
    // and the trainer; the sub-agent list carried only the one that CHANGES a task.
    for (const verb of ['work_open', 'work_update']) {
      expect(PRIMARY_AGENT_ALWAYS_LOADED, `primary/${verb}`).toContain(verb);
      expect(SUB_AGENT_ALWAYS_LOADED, `sub-agent/${verb}`).toContain(verb);
    }
  });

  it('THE RED: work_update.task_id declares that the id must already exist', () => {
    const def = toolDefinitions.find((d) => d.name === 'work_update');
    expect(def, 'work_update is declared').toBeTruthy();
    const desc = String((def!.input_schema as { properties: Record<string, { description?: string }> })
      .properties.task_id.description ?? '');
    // The schema demanded an id and said nothing about where one comes from, so under the
    // END-OF-TURN decision matrix's pressure the model supplied a word.
    expect(desc).toMatch(/work_open/);
    expect(desc.toLowerCase()).toMatch(/never invent/);
  });
});
