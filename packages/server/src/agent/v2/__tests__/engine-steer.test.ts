// RC-19 conformance guard.
//
// The engine may only steer the model through a channel the model can actually
// see. The memory assembler strips role='system' rows from model context, so a bare
// role='system' INSERT that tells the agent to DO or STOP something is
// "dashboard-only theater": it fires in logs and the dashboard while the model never
// receives it. The rule (from the thrash-gate comment in loop.ts) is that any such
// directive must also set `pendingNudge`. The recurrence history (F-18, the F-7
// recurrences) is a PROCESS failure: the lesson lived as a comment plus a list of
// corrected sites, so nothing stopped the next engineer from writing a new bare
// steer. This test converts the lesson into a build-enforced invariant.
//
// Two assertions:
//   1. persistEngineSteer does BOTH writes (the role='system' row AND pendingNudge).
//   2. Source-scan of loop.ts: no raw role='system' INSERT whose surrounding block
//      carries imperative-to-agent text may exist without a paired delivery
//      (pendingNudge / persistEngineSteer) or an explicit `engine-steer-exempt`
//      sentinel documenting why it is not a model-visible steer (an enforced gate,
//      a terminal note, an informational marker). A NEW bare imperative steer that
//      copies the old raw-INSERT pattern fails CI here.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WsEvent } from '@dojo/shared';
import { persistEngineSteer } from '../engine-steer.js';
import { initState, type AgentTurnState } from '../state.js';

function freshState(): AgentTurnState {
  return initState({
    agentId: 'test-agent',
    contextWindow: 200000,
    isAutoRouted: false,
    configuredModelId: 'claude-sonnet-4-6',
    turnNumber: 3,
    triggeredByIMessage: false,
    triggeredByA2AReplyIntent: null,
    imFlagSetAtRunStart: false,
    lastUserMessageContent: null,
  });
}

describe('persistEngineSteer: does both writes', () => {
  it('inserts a role=system row AND sets pendingNudge on the returned state', () => {
    let runArgs: unknown[] = [];
    let runSql = '';
    const events: WsEvent[] = [];
    const deps = {
      db: {
        prepare(sql: string) {
          runSql = sql;
          return {
            run(...args: unknown[]) {
              runArgs = args;
              return undefined;
            },
          };
        },
      },
      broadcast(event: WsEvent) {
        events.push(event);
      },
    } as unknown as Parameters<typeof persistEngineSteer>[2];

    const before = freshState();
    const content = '[System: STOP and call tracker_create_project.]';
    const after = persistEngineSteer(before, { agentId: 'a1', content, turnNumber: 7 }, deps);

    // Dashboard row: a role='system' INSERT carrying the content.
    expect(runSql).toMatch(/INSERT/);
    expect(runSql).toMatch(/'system'/);
    expect(runArgs).toContain(content);

    // Dashboard broadcast: chat:message with the content.
    const chatMsg = events.find((e) => e.type === 'chat:message');
    expect(chatMsg).toBeTruthy();
    if (chatMsg && chatMsg.type === 'chat:message') {
      expect(chatMsg.message.role).toBe('system');
      expect(chatMsg.message.content).toBe(content);
    }

    // Model-visible delivery: pendingNudge set on the returned state.
    expect(after.pendingNudge).toBe(content);
    expect(before.pendingNudge).toBeNull(); // input not mutated
  });

  it('merges extra one-shot flags into the same advance', () => {
    const deps = {
      db: { prepare: () => ({ run: () => undefined }) },
      broadcast: () => undefined,
    } as unknown as Parameters<typeof persistEngineSteer>[2];
    const after = persistEngineSteer(
      freshState(),
      { agentId: 'a1', content: 'x', turnNumber: 1, extra: { nudgedForTrackerThisTurn: true } },
      deps,
    );
    expect(after.nudgedForTrackerThisTurn).toBe(true);
    expect(after.pendingNudge).toBe('x');
  });

  it('still sets pendingNudge even if the dashboard row write throws (delivery is load-bearing)', () => {
    const deps = {
      db: {
        prepare: () => ({
          run: () => {
            throw new Error('db down');
          },
        }),
      },
      broadcast: () => undefined,
    } as unknown as Parameters<typeof persistEngineSteer>[2];
    const after = persistEngineSteer(freshState(), { agentId: 'a1', content: 'y', turnNumber: 1 }, deps);
    expect(after.pendingNudge).toBe('y');
  });
});

// ── Source-scan invariant ──────────────────────────────────────────────────────

const LOOP_TS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../loop.ts');

// The VALUES row of a role='system' messages INSERT (2-arg id/agent_id prefix).
const SYSTEM_INSERT = /VALUES\s*\(\s*\?,\s*\?,\s*'system'/;

// Imperative-to-agent shapes. Case-sensitive on purpose: prose "must"/"do not"
// (lowercase) is fine; the SHOUTED forms are the directive tells. Covers the three
// named RC-19 violators (STOP + call tracker_ for the tracker steer, KEEP GOING for
// the add-notes-stop nudge, "Never tell the user" for the claimed-delivery guard)
// plus the general MUST / Do NOT / call tracker_ shapes.
const IMPERATIVE = /\bSTOP\b|\bMUST\b|\bDo NOT\b|call tracker_|KEEP GOING|Never tell the user/;

// A site is compliant if its block pairs the row with a real delivery or is an
// explicitly documented non-steer.
const PAIRED = /pendingNudge|persistEngineSteer|engine-steer-exempt/;

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

describe('RC-19: no bare-system imperative steer in loop.ts (build-enforced invariant)', () => {
  it('every role=system INSERT with imperative content pairs a model-visible delivery or is documented exempt', () => {
    const lines = fs.readFileSync(LOOP_TS, 'utf8').split('\n');
    const violations: string[] = [];

    lines.forEach((line, i) => {
      if (!SYSTEM_INSERT.test(line)) return;
      // Window: content literals sit ABOVE the INSERT (built into a variable),
      // pendingNudge / persistEngineSteer / exempt sentinels sit just below or above.
      const start = Math.max(0, i - 40);
      const end = Math.min(lines.length, i + 20);
      const window = lines.slice(start, end);

      // Imperative detection ignores comment lines so a doc mention of a shape
      // (or a nearby unrelated comment) can't trip it. Content lives in code
      // (template strings), so real steer text is still seen.
      const codeText = window.filter((l) => !isCommentLine(l)).join('\n');
      if (!IMPERATIVE.test(codeText)) return;

      // Pairing / exemption may live in a comment (the sentinel) or code, so scan
      // the raw window.
      if (PAIRED.test(window.join('\n'))) return;

      violations.push(`loop.ts:${i + 1} | bare role='system' imperative steer (no pendingNudge / persistEngineSteer / engine-steer-exempt in block)`);
    });

    // If this fails: route the steer through persistEngineSteer (so it reaches the
    // model via pendingNudge, not just the dashboard), or, if the row is genuinely
    // NOT a model-visible directive (an enforced gate, a terminal status note, an
    // informational marker), add an `engine-steer-exempt: <reason>` comment in the
    // block documenting why. See engine-steer.ts and RC-19.
    expect(violations).toEqual([]);
  });

  it('loop.ts actually routes engine steers through persistEngineSteer (guards against the scan silently matching nothing)', () => {
    const src = fs.readFileSync(LOOP_TS, 'utf8');
    const helperCalls = (src.match(/persistEngineSteer\(/g) ?? []).length;
    // The three named RC-19 violators plus the additional same-turn steers found in
    // the audit sweep are all routed through the helper.
    expect(helperCalls).toBeGreaterThanOrEqual(6);
  });
});
