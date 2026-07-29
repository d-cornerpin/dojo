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
const ROOTS = ['server/src', 'shared/src', 'dashboard/src'];

function walk(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'migrations' || e.name === 'node_modules') continue;
      walk(fp, acc);
    } else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) acc.push(fp);
  }
  return acc;
}

const files = ROOTS.flatMap((r) => walk(path.join(PKGS, r)))
  .map((f) => path.relative(PKGS, f).split(path.sep).join('/'))
  .sort();

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
    allow: {
      'dashboard/src/pages/Chat.tsx':
        'the render chain still compares the literal inline (:1811 comment, :1813 test). ' +
        'SWEEP-E owns the client half of the marker leak (17 §C4/§C5) and re-points it to ' +
        'NO_REPLY_CLOSED_MARKER; T8 owns the write half and is not permitted to change what ' +
        'the owner sees.',
    },
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
    allow: {
      'dashboard/src/pages/Chat.tsx':
        'WORKING_NOTE_PREFIX / INTERNAL_WORKING_NOTE_PREFIX are still declared client-side ' +
        'for the reload-path render. SWEEP-E imports them from @dojo/shared instead.',
    },
  },
  {
    name: 'the owner-alert allowlist',
    owner: OWNER,
    exports: ['OWNER_ALERT_HEADS_UP_PREFIX', 'OWNER_ALERT_PROJECT_ATTENTION_PREFIX', 'OWNER_ALERT_SYSTEM_PREFIXES', 'isOwnerAlertSystemNote'],
    pattern: /['"`](Heads up:|\[tracker:project_needs_attention\])/,
    allow: {
      'dashboard/src/pages/Chat.tsx':
        'OWNER_ALERT_SYSTEM_PREFIXES is still declared client-side. The canonical list is now ' +
        'in @dojo/shared and the three server write sites take their prefix FROM it; SWEEP-E ' +
        'deletes the client copy when it re-points the render.',
    },
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

const read = (rel: string) => fs.readFileSync(path.join(PKGS, rel), 'utf8');

/** The file with its COMMENT lines removed.
 *
 *  A comment that names a marker is documentation and we want more of it, not less — this
 *  codebase's comments are where the incidents behind each guard are recorded. A second
 *  MATCHER is the thing that drifts. Dropping whole-line comments (`//…` and a jsdoc
 *  continuation `*…`) separates the two cheaply and without a parser; a marker literal in
 *  live code always sits on a line that is not one of those. */
const code = (rel: string) =>
  read(rel)
    .split('\n')
    .filter((l) => {
      const t = l.trimStart();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');

describe('marker ownership — one matcher per marker (17 §C5)', () => {
  it('walks all three packages and finds real files', () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain(OWNER);
    expect(files).toContain('server/src/agent/v2/loop.ts');
    expect(files).toContain('dashboard/src/pages/Chat.tsx');
  });

  for (const m of MARKERS) {
    it(`${m.name}: only ${m.owner} + ${Object.keys(m.allow).length} allowlisted`, () => {
      const offenders = files.filter((f) => f !== m.owner && m.pattern.test(code(f)));
      const unexplained = offenders.filter((f) => !(f in m.allow));
      expect(unexplained, `${m.name}: a second copy with no owner`).toEqual([]);
      // And the allowlist stays honest in the other direction: an entry that no longer
      // matches is a stale exception, which is how allowlists rot into permission slips.
      const stale = Object.keys(m.allow).filter((f) => !offenders.includes(f));
      expect(stale, `${m.name}: allowlist entries that no longer match anything`).toEqual([]);
    });

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

// ── Vocabularies that OVERLAP the taxonomy and are deliberately NOT folded into it ──
//
// Step 4 of this task's brief: anything still hand-rolling classification outside the shared
// module is either converted or ENUMERATED WITH ITS REASON. These are the enumeration, kept
// as a live assertion rather than a comment so the list cannot quietly grow.

describe('the deliberate non-folds', () => {
  const NOT_FOLDED: Array<{ file: string; what: string; why: string }> = [
    {
      file: 'server/src/memory/platform-noise.ts',
      what: 'PLATFORM_NOISE_PATTERNS',
      why: 'A DIFFERENT QUESTION, and this list proves it: the display taxonomy classifies a '
        + '"── New Session ──" divider as USER-VISIBLE while this list excludes it from '
        + 'summaries. "What a human sees" and "what may enter a summary" disagree on real '
        + 'entries, so collapsing them would make a summariser change a display change. The '
        + 'divider SHAPE is imported from @dojo/shared; only the membership is local.',
    },
    {
      file: 'server/src/memory/summary-rebuild.ts',
      what: 'the contamination pattern list',
      why: 'Same question as platform-noise.ts, same answer. Shape imported, policy local.',
    },
    {
      file: 'server/src/services/imessage-bridge.ts',
      what: 'stripSystemTags',
      why: 'Strips routing tags the MODEL hallucinated back into its own reply before that '
        + 'text is sent to a phone. It is an outbound-channel concern, not a display tier, '
        + 'and it runs on text that is never a row.',
    },
    {
      file: 'server/src/agent/v2/classifiers/output.ts',
      what: 'stripLeadingTimeStamp',
      why: 'Removes the per-message date stamp the assembler prefixes into the MODEL PAYLOAD '
        + '(pinned by bytes in memory/__tests__/message-time-stamps.test.ts, T6b). A payload '
        + 'concern with its own gate; the display columns never enter the payload.',
    },
    {
      file: 'server/src/voice/text-sanitize.ts',
      what: 'sanitizeForSpeech',
      why: 'Turns text into something a TTS engine pronounces naturally (markdown, URLs, '
        + 'paths). Not classification. Its ONE display marker — the orb mood — now comes '
        + 'from @dojo/shared.',
    },
    {
      file: 'server/src/agent/v2/loop.ts',
      what: 'DECLINE_OPENER_RE',
      why: 'An engine BEHAVIOUR classifier over the model\'s prose ("is this a decline?"), '
        + 'deciding whether a row is written at all. It reads meaning, not markers. OR2 / '
        + 'PHASE 4 owns the engine\'s prose judgements. (Its former neighbour here, '
        + '`isGenericCloseout`, was DELETED by PHASE-2 T6: the redundant-closeout floor it '
        + 'served is keyed on the delivery ledger now, not on a phrase list.)',
    },
  ];

  it('every enumerated non-fold still exists, so the reason still has a subject', () => {
    for (const n of NOT_FOLDED) {
      expect(files, `${n.file} named in the non-fold list but not in the tree`).toContain(n.file);
      expect(read(n.file).includes(n.what.split(' ')[0]), `${n.file} no longer has ${n.what}`)
        .toBe(true);
    }
  });
});
