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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Every tracked .ts under src/, excluding tests — the shipped surface. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue;
      sourceFiles(full, out);
    } else if (e.name.endsWith('.ts') && !e.name.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

const BOUNDARY_WRITE = /session_started_at\s*=\s*\?/;

describe('§1 THE CENSUS — every session-boundary writer comes through one owner', () => {
  const files = sourceFiles(SRC);
  const writers = files.filter((f) => BOUNDARY_WRITE.test(fs.readFileSync(f, 'utf-8')));

  it('finds the five doors the audit measured, and no unmeasured sixth', () => {
    const rel = writers.map((f) => path.relative(SRC, f)).sort();
    // If this list grows, the new door owes the assertion below. If it SHRINKS, a door was
    // retired and the count here is the reminder to re-read this file.
    expect(rel).toEqual([
      'agent/tools/cat/session.ts',   // the reset_session TOOL
      'gateway/routes/agents.ts',     // the agent card's reset
      'gateway/routes/chat.ts',       // the chat pane's new-session button
      'gateway/routes/system.ts',     // the bulk idle sweep
      'vault/maintenance.ts',         // the Dreamer's fresh-start cycle
    ]);
  });

  it('EVERY one of them calls forgetSessionScratch — the clause the drift needed', () => {
    const missing = writers
      .filter((f) => !fs.readFileSync(f, 'utf-8').includes('forgetSessionScratch'))
      .map((f) => path.relative(SRC, f));
    expect(missing, 'a door that moves the session boundary must forget the per-session '
      + 'scratch; before this clause, three of five did not').toEqual([]);
  });

  it('no door hand-rolls the clears any more — one owner, so they cannot drift again', () => {
    // `session-forget.ts` is the only site allowed to name the two cleaners. A door that
    // calls one directly is the shape that produced four different answers.
    const offenders: string[] = [];
    for (const f of writers) {
      const text = fs.readFileSync(f, 'utf-8');
      // The tool door legitimately DISCUSSES `clearSessionLoadedTools` in its W4 note, so the
      // test looks for a CALL — the name followed by an open paren — not a mention.
      if (/clearSessionLoadedTools\s*\(/.test(text) || /clearServedConversations\s*\(/.test(text)) {
        offenders.push(path.relative(SRC, f));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the owner itself is the one place that names both cleaners', () => {
    const owner = fs.readFileSync(path.join(SRC, 'agent/session-forget.ts'), 'utf-8');
    expect(owner).toContain('clearSessionLoadedTools(agentId)');
    expect(owner).toContain('clearServedConversations(agentId)');
  });
});

// ── §2 the behaviour, once, at the owner ────────────────────────────────────────────────

const cleared: string[] = [];
vi.mock('../../tools/tool-docs.js', () => ({
  clearSessionLoadedTools: (id: string) => cleared.push(`tools:${id}`),
}));
vi.mock('../turn-state.js', () => ({
  clearServedConversations: (id: string) => cleared.push(`served:${id}`),
}));

describe('§2 THE OWNER clears both, and a failure in one never eats the other', () => {
  beforeEach(() => { cleared.length = 0; });

  it('clears the session-loaded tool docs AND the turn-continuity scratch', async () => {
    const { forgetSessionScratch } = await import('../session-forget.js');
    await forgetSessionScratch('agent-1');
    expect(cleared).toEqual(['tools:agent-1', 'served:agent-1']);
  });

  it('is best-effort PER CLEAR: a throwing first half still lets the second half run', async () => {
    const { forgetSessionScratch } = await import('../session-forget.js');
    const docs = await import('../../tools/tool-docs.js');
    const original = docs.clearSessionLoadedTools;
    // A reset that cannot drop the tool docs must still drop the continuity scratch — and must
    // not throw, because no door may fail a reset over its scratch state.
    (docs as { clearSessionLoadedTools: (id: string) => void }).clearSessionLoadedTools = () => {
      throw new Error('tool-docs module unavailable');
    };
    try {
      await expect(forgetSessionScratch('agent-2')).resolves.toBeUndefined();
      expect(cleared).toEqual(['served:agent-2']);
    } finally {
      (docs as { clearSessionLoadedTools: (id: string) => void }).clearSessionLoadedTools = original;
    }
  });
});
