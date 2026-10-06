import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
// ════════════════════════════════════════════════════════════════════════════════════════
// THE SERVER HALF — THE SIGNAL R4 READS HAS TO BE ON THE WIRE, NOT ONLY IN THE TABLE.
//
// `messages.conversation_id` was stamped at ingest and projected by the history route, so a
// RELOADED feed always had it; the `chat:message` frame the LIVE feed builds its row from did
// not carry it. One fact served two ways is the live-view/reload disagreement this tree keeps
// naming, and with R4 in place it is a visible one: the owner's own reply stayed collapsed
// until he refreshed, then quietly un-collapsed.
//
// A SOURCE CLAUSE, and it counts BOTH WAYS (G4): it does not look for one line, it finds every
// `role: 'user'` frame this route broadcasts and requires each of them to carry the column. A
// future second user-row door added without it is RED here rather than silently lagging.
// Comments are stripped first, so the prose above the call cannot satisfy it.
// ════════════════════════════════════════════════════════════════════════════════════════
describe("the live frame carries the person's conversation, not just the stored row", () => {
  /** The route source with comments removed, so only code can satisfy the clauses below. */
  const routeSource = (): string => readFileSync('src/gateway/routes/chat.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

  /** Every `broadcast({ … })` argument literal in the file, by brace matching. */
  const broadcastLiterals = (src: string): string[] => {
    const out: string[] = [];
    for (let i = src.indexOf('broadcast({'); i !== -1; i = src.indexOf('broadcast({', i + 1)) {
      let depth = 0;
      const open = src.indexOf('{', i);
      for (let j = open; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') { depth--; if (depth === 0) { out.push(src.slice(open, j + 1)); break; } }
      }
    }
    return out;
  };

  it("every user-role chat:message frame this route sends carries `conversationId`", () => {
    const frames = broadcastLiterals(routeSource())
      .filter((f) => f.includes("type: 'chat:message'") && /role:\s*'user'/.test(f));
    expect(frames.length, 'the route stopped broadcasting user rows — re-read this clause').toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame, 'a user-row frame went out without the conversation the insert already resolved')
        .toMatch(/\bconversationId\b/);
    }
  });

  it('and it is the SAME binding the insert used — one resolve, two consumers, never two resolves', () => {
    const src = routeSource();
    // `resolveOrCreateConversation` is called ONCE in this door and its result is what both the
    // insert and the frame name. A second call would be a second writer for one fact.
    expect((src.match(/resolveOrCreateConversation\(/g) ?? []).length).toBe(1);
    expect(src).toMatch(/const conversationId = resolveOrCreateConversation\(/);
  });
});
