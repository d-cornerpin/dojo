// ════════════════════════════════════════════════════════════════════════════════════════
// EVERY OWNER-ALERT ROW REACHES THE SOCKET — the census, SWEEP-A TB4.
//
// WHY A CENSUS AND NOT ANOTHER UNIT TEST. Full battery `bmsgc3l0cnb` tripped
// `BROADCAST_EQUALS_ROW` for the first time in the invariant's life on ONE row —
// `recordFloorGhost`'s owner-alert note, written user-visible and announced on nothing. Fixing
// that one site fixes an instance. The defect is a CLASS: the platform addresses the owner
// directly from six places, each writes its row with its own hand-built call, and nothing made
// any of them announce it. A second site (`thrash-gate.ts`) carried the identical defect and had
// simply never fired inside an observation window.
//
// So the guard is a census, in the family of `marker-ownership.test.ts`: it reads the SOURCE and
// asserts every owner-alert write resolves to the one announce door. A new writer that forgets
// the wire fails the build instead of waiting for a battery to catch it years later.
//
// THE DOOR, named once: `gateway/ws.ts:broadcast()`, whose first act is the PHASE-1 T9 seam
// `stampPersistedRow` — it looks the emission up BY ITS OWN ID in the database and stamps
// `content`, `createdAt` and the `row` payload off what is stored, so the frame and the row
// cannot disagree. A user-visible row is "announced" exactly when a `chat:message` naming its id
// goes through that function.
//
// WHAT COUNTS AS CONFORMING, and both forms are real:
//   · the row is written and a `chat:message` goes out beside it — the owner-lane form;
//   · the note is posted through `postAgentNotice`, which is the EVENTS lane: `lane='events'`,
//     `display_tier='agent-only'` (measured on the live box: 87 of 87 `fanout_join` rows), so it
//     is not a user-visible row at all and the invariant does not reach it. It announces on
//     `interagent:message` through the same door.
//
// The window is deliberately generous (the write and its announcement are adjacent at every
// conforming site — one line apart at three of them) and the failure message names the file and
// line, so a red is actionable without reading this header.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');

/** The scope a site is judged in: its own top-level declaration, found by scanning out to the
 *  nearest column-0 `function` / `const … =` / `export …` boundary in each direction. Line
 *  windows were tried first and rejected — `a2a-transport.ts` composes its platform-voice notice
 *  74 lines before it announces it, with four channel-delivery branches in between, and a window
 *  wide enough to accept that would start reading OTHER functions' broadcasts as this one's. */
const DECL_START = /^(export\s+)?(default\s+)?(async\s+)?(function\s|const\s|class\s|type\s|interface\s)/;

function enclosingDeclaration(lines: string[], at: number): string {
  let from = at;
  while (from > 0 && !DECL_START.test(lines[from])) from -= 1;
  let to = at + 1;
  while (to < lines.length && !DECL_START.test(lines[to])) to += 1;
  return lines.slice(from, to).join('\n');
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      sourceFiles(p, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

describe('the owner-alert census: a row the owner can see always reaches the socket', () => {
  it('every site that composes an owner-alert note announces it through the one door', () => {
    const offenders: string[] = [];
    let sites = 0;

    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('OWNER_ALERT_HEADS_UP_PREFIX')) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        // The composition site: the prefix being put in front of a sentence for the owner.
        // Its own import line and any comment mentioning it are not writes.
        const line = lines[i];
        if (!/\$\{OWNER_ALERT_HEADS_UP_PREFIX\}/.test(line)) continue;
        sites += 1;
        const scope = enclosingDeclaration(lines, i);
        const announced = /type:\s*'chat:message'/.test(scope) || /postAgentNotice\(/.test(scope);
        if (!announced) {
          offenders.push(`${file.slice(SRC.length + 1)}:${i + 1} — an owner-alert row is composed here and no chat:message announces it (silent insert: reload-only)`);
        }
      }
    }

    // The census must have something to census. A refactor that renames the prefix would
    // otherwise turn this into a permanently green no-op, which is the failure mode this whole
    // module family exists to refuse.
    expect(sites).toBeGreaterThanOrEqual(5);
    expect(offenders).toEqual([]);
  });

  it('NEGATIVE CONTROL: the census can fail — a composed note with no announcement is caught', () => {
    // The same predicate the clause above runs, over a synthetic file carrying the exact shape
    // the battery found. If this passes, the clause above proves nothing.
    const planted = [
      "const msg = `${OWNER_ALERT_HEADS_UP_PREFIX} something went wrong`;",
      "insertMessageIfAbsent({ id, agentId, role: 'system', content: msg });",
      "broadcast({ type: 'chat:error', agentId, error: msg, code: 'X', severity: 'warning', retryable: false });",
    ].join('\n');
    const announced = /type:\s*'chat:message'/.test(planted) || /postAgentNotice\(/.test(planted);
    expect(announced).toBe(false);

    // …and the matched control: the same file WITH the announcement passes.
    const fixed = `${planted}\nbroadcast({ type: 'chat:message', agentId, message });`;
    expect(/type:\s*'chat:message'/.test(fixed)).toBe(true);
  });
});
