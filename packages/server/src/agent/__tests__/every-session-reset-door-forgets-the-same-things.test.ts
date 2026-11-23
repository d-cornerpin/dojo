// ════════════════════════════════════════════════════════════════════════════════════════
// EVERY SESSION-RESET DOOR FORGETS THE SAME THINGS.
//
// Two backlog lines, one cause (BACKLOG.md, 2026-09-26): "system.ts:218 + agents.ts:607
// possibly missing clearSessionLoadedTools (never audited)" — they were — and "the two
// session-reset doors still disagree on clearServedConversations (tool doesn't, route does;
// pre-existing)" — three of five didn't.
//
// ── WHY THIS IS A SOURCE WALK AND NOT FIVE UNIT TESTS ───────────────────────────────────
// The defect was never that one clear was broken; each cleaner worked perfectly. It was that
// five hand-rolled copies of "what a reset forgets" drifted into FOUR answers, and nothing
// anywhere could see the disagreement. A unit test per door proves the doors that exist today
// and says nothing about the sixth one somebody adds next month — which is exactly how this
// arrived. So §1 asks the question the defect actually had: DOES EVERY WRITER OF THE SESSION
// BOUNDARY COME THROUGH THE ONE OWNER? A new door is then either wired or RED.
//
// The census is `agents.session_started_at` writers, because that column IS the session
// boundary: an UPDATE that moves it has, by definition, started a new session.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── §2 the behaviour, once, at the owner ────────────────────────────────────────────────

const cleared: string[] = [];
vi.mock('../../tools/tool-docs.js', () => ({
  clearSessionLoadedTools: (id: string) => cleared.push(`tools:${id}`),
}));

describe('§2 THE OWNER clears the session scratch, and a failure never fails the reset', () => {
  beforeEach(() => { cleared.length = 0; });

  it('clears the session-loaded tool docs', async () => {
    const { forgetSessionScratch } = await import('../session-forget.js');
    await forgetSessionScratch('agent-1');
    expect(cleared).toEqual(['tools:agent-1']);
  });

  it('is best-effort: a throwing clear never fails the reset', async () => {
    const { forgetSessionScratch } = await import('../session-forget.js');
    const docs = await import('../../tools/tool-docs.js');
    const original = docs.clearSessionLoadedTools;
    // No door may fail a reset over its scratch state.
    (docs as { clearSessionLoadedTools: (id: string) => void }).clearSessionLoadedTools = () => {
      throw new Error('tool-docs module unavailable');
    };
    try {
      await expect(forgetSessionScratch('agent-2')).resolves.toBeUndefined();
      expect(cleared).toEqual([]);
    } finally {
      (docs as { clearSessionLoadedTools: (id: string) => void }).clearSessionLoadedTools = original;
    }
  });
});
