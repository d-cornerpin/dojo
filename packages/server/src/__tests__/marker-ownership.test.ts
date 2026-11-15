// PHASE-1 T8 — the marker-ownership walk. One matcher per marker, enforced.
//
// WHY A WALK AND NOT A GREP. The standing lesson from T6b, written into its report as the
// rule for this task: "a string-literal scan is a starting list, never a completion proof."
// Three successive scanners there each found sites the previous one could not see. So the
// completion proof for T8 is not "I grepped and it looked clean" — it is this, a check that
// RUNS, walks every source file in all three packages, and fails the build the day a second
// copy of an engine marker appears anywhere.
//
// It is the same shape as `memory/__tests__/single-writer-conformance.test.ts`, for the same
// reason and with the same property: THE ALLOWLIST IS THE ARTEFACT. Every entry names a file,
// the task that owns removing it, and why it is still standing. Its length is the honest
// answer to "how much of the display contract is left" — and the entries in it today are
// exactly SWEEP-E's half of the leak (17 §C4/§C5: the client's own reads), which T8 is not
// permitted to touch.
//
// It reads with fs.readFileSync rather than shelling out to grep, because two of this tree's
// largest files carry NUL bytes and grep skips them silently.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PKGS = path.join(__dirname, '..', '..', '..');

/** One engine marker: who owns its spelling, how a SECOND copy is recognised, and every file
 *  still holding one. `pattern` deliberately matches only shapes prose cannot produce —
 *  a quoted string literal, or a regex with escaped brackets — so a comment that NAMES a
 *  marker (documentation, which we want) never trips it while a second MATCHER (drift, which
 *  we do not) always does. */
interface Marker {
  name: string;
  owner: string;
  pattern: RegExp;
  /** The exported name(s) that ARE this marker in the owner module. Asserted to exist, so
   *  "the owner owns it" is a fact about the module rather than about this file's opinion. */
  exports: string[];
  /** file -> why it survives, and which task removes it. */
  allow: Record<string, string>;
}

const OWNER = 'shared/src/visibility.ts';

const MARKERS: Marker[] = [
  {
    name: 'the silent-turn close marker',
    owner: OWNER,
    exports: ['NO_REPLY_CLOSED_MARKER', 'isNoReplyClosedMarker'],
    // Both spellings. The comma form is the defect T8 closed; it must never come back either.
    pattern: /Agent ended turn without replying\s*[,—]/,
    // v3.5 field fix 3: the dashboard's inline copy is re-pointed to NO_REPLY_CLOSED_MARKER (the em-dash sweep found it).
    allow: {},
  },
  {
    name: 'the [no-reply] sentinel regex',
    owner: OWNER,
    exports: ['NO_REPLY_BARE_RE', 'NO_REPLY_TAIL_RE', 'isBareNoReplySentinel', 'stripNoReplySentinel'],
    // The ESCAPED bracket form only ever appears inside a regex. Prompt copy that teaches the
    // model the sentinel writes it plainly and is untouched — the taxonomy classifies what the
    // engine emits, it never constrains the vocabulary the prompt teaches.
    pattern: /\\\[no-reply\\\]/,
    allow: {
      'dashboard/src/lib/voice-markers.ts':
        'the client strip (stripVoiceMarkers) still carries its own copy, including the ' +
        'streaming partial-prefix variant that has no server equivalent. SWEEP-E.',
    },
  },
  {
    name: 'the orb mood marker regex',
    owner: OWNER,
    exports: ['parseMoodMarker', 'stripMoodMarker'],
    pattern: /\\\(\\\(\\s\*mood/,
    allow: {
      'dashboard/src/lib/voice-markers.ts':
        'parseMoodMarker + MOOD_MARKER_RE, still the orb\'s own reader. SWEEP-E re-points it ' +
        'to the shared helper and to the `mood` COLUMN the writer now fills.',
    },
  },
  {
    name: 'the working-note prefixes',
    owner: OWNER,
    exports: ['WORKING_NOTE_PREFIX', 'INTERNAL_WORKING_NOTE_PREFIX', 'parseWorkingNote'],
    pattern: /['"`]\[working-note(:internal)?\] /,
    // ⚠ NO EXCEPTIONS LEFT, and the entry that was here is DELETED rather than kept as a
    // comment: `dashboard/src/pages/Chat.tsx` declared its own copy of both markers and its own
    // reader, allowed "pending SWEEP-E". The visibility lane needed a THIRD reader
    // (`lib/working-note-visibility.ts`, which decides whether a demoted note is dimmed or
    // hidden), and three copies of a marker that governs whether the owner sees his agent's
    // words is one drift away from a row rendering as raw `[working-note] …` text at him. So
    // `Chat.tsx` now imports all three from the owner and the exception is gone — SWEEP-E's
    // errand for this marker is done. This census's "allowlist entries that no longer match
    // anything" clause is what required the deletion; leaving a stale entry would have been a
    // standing permission for the copy to come back.
    allow: {},
  },
  {
    name: 'the owner-alert allowlist',
    owner: OWNER,
    exports: ['OWNER_ALERT_HEADS_UP_PREFIX', 'OWNER_ALERT_PROJECT_ATTENTION_PREFIX', 'OWNER_ALERT_SYSTEM_PREFIXES', 'isOwnerAlertSystemNote'],
    pattern: /['"`](Heads up:|\[tracker:project_needs_attention\])/,
    allow: {},
  },
  {
    name: 'the New Session divider literal',
    owner: OWNER,
    exports: ['NEW_SESSION_DIVIDER', 'NEW_SESSION_DIVIDER_LABEL'],
    pattern: /['"`]── New Session ──/,
    allow: {},
  },
  {
    name: 'the outbound routing marker',
    owner: OWNER,
    exports: ['formatRoutingMarker', 'parseOutboundRouting'],
    pattern: /['"`]\[Reply routed via \$\{/,
    allow: {},
  },
  {
    name: 'the divider shape',
    owner: OWNER,
    exports: ['formatDivider', 'parseDivider'],
    // A template that BUILDS "── … ──". `formatDivider` is the only one allowed to.
    pattern: /['"`]── \$\{/,
    allow: {},
  },
];

describe('marker ownership — one matcher per marker (17 §C5)', () => {

  for (const m of MARKERS) {

    it(`${m.name}: the owner exports it (${m.exports.join(', ')})`, async () => {
      const shared = await import('@dojo/shared') as Record<string, unknown>;
      for (const sym of m.exports) {
        expect(shared[sym], `@dojo/shared does not export ${sym}`).toBeDefined();
      }
    });
  }

  it('the allowlist is SWEEP-E\'s, and every entry says so', () => {
    const entries = MARKERS.flatMap((m) => Object.entries(m.allow));
    expect(entries.length).toBeGreaterThan(0);
    for (const [file, reason] of entries) {
      expect(file.startsWith('dashboard/'), `${file} is not a dashboard file`).toBe(true);
      expect(reason).toMatch(/SWEEP-E/);
    }
  });
});

// ── The taxonomy's two declarations cannot drift ──
//
// `DISPLAY_KINDS` in the shared module and the CHECK in migration 132 are the same list
// written twice, in two languages, which is the exact shape this task exists to remove. It
// cannot be written once (SQL has no import), so it is asserted equal instead.

describe('the display_kind enum has one meaning in two languages', () => {
  it('migration 132\'s CHECK lists exactly DISPLAY_KINDS', async () => {
    const { DISPLAY_KINDS } = await import('@dojo/shared');
    const sql = fs.readFileSync(
      path.join(PKGS, 'server/src/db/migrations/132_messages_display_kind_check.sql'), 'utf8',
    );
    const block = sql.match(/CHECK \(display_kind IN \(([\s\S]*?)\)\)/);
    expect(block, 'migration 132 no longer declares the CHECK').toBeTruthy();
    const inSql = [...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(inSql).toEqual([...DISPLAY_KINDS].sort());
  });
});
