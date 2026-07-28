// PHASE-1 T8 — the ONE display taxonomy, and every engine literal it must classify.
//
// 17 §C1/C5: one classifier, one set of kinds and tiers, one matcher per marker, and a test
// that asserts EVERY writer literal parses. That last clause is not decoration — it is the
// test that would have caught the defect this task exists to close: the engine wrote
// `[Agent ended turn without replying, conversation closed]` with a COMMA while both
// matchers expected an EM-DASH, so the marker was invisible to its own reader and rendered
// raw in the owner's chat. A marker with two spellings has no owner.
//
// The literals below are therefore BUILT from the shared constants wherever a constant
// exists. A future edit that forks a spelling fails here; a future edit that forks it in the
// engine instead fails `src/__tests__/marker-ownership.test.ts`, which walks the tree and
// refuses a second copy of any of these strings outside the module that owns them.

import { describe, it, expect } from 'vitest';
import {
  classifyMessageForDisplay,
  DISPLAY_KINDS,
  DISPLAY_TIERS,
  NO_REPLY_CLOSED_MARKER,
  WORKING_NOTE_PREFIX,
  INTERNAL_WORKING_NOTE_PREFIX,
  OWNER_ALERT_HEADS_UP_PREFIX,
  OWNER_ALERT_PROJECT_ATTENTION_PREFIX,
  NEW_SESSION_DIVIDER,
  formatDivider,
  parseWorkingNote,
  isOwnerAlertSystemNote,
  parseMoodMarker,
  stripMoodMarker,
  isBareNoReplySentinel,
  stripNoReplySentinel,
  type DisplayKind,
  type VisibilityTier,
} from '@dojo/shared';

// ── The enum itself ──

describe('the taxonomy is one closed vocabulary', () => {
  it('DISPLAY_KINDS is 17 §C1 exactly, plus the R1 fail-open default', () => {
    expect([...DISPLAY_KINDS].sort()).toEqual([
      'a2a', 'agent-text', 'divider', 'engine-note', 'fallback', 'no-reply-marker',
      'owner-alert', 'routing-marker', 'tool-turn', 'unclassified', 'user-text',
      'working-note',
    ]);
  });

  it('DISPLAY_TIERS is the three tiers the column already CHECKs', () => {
    expect([...DISPLAY_TIERS].sort()).toEqual(['agent-only', 'never-shown', 'user-visible']);
  });
});

// ── Every writer literal round-trips ──
//
// Each row names the engine site that writes it. `content` is assembled from the shared
// constant where one exists, so this table and the writer cannot disagree by construction.

interface Case {
  site: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  lane?: 'owner' | 'a2a' | 'events';
  originIntent?: string | null;
  kind: DisplayKind;
  tier: VisibilityTier;
}

const WRITER_LITERALS: Case[] = [
  // The marker at the heart of this task. Written by agent/v2/loop.ts's no-reply branch.
  { site: 'loop.ts no-reply close', role: 'system', content: NO_REPLY_CLOSED_MARKER,
    kind: 'no-reply-marker', tier: 'never-shown' },

  // Demoted mid-work narration (loop.ts demotion + the proactive-send demote).
  { site: 'loop.ts working-note demote', role: 'system',
    content: `${WORKING_NOTE_PREFIX}Let me check the calendar first.`,
    kind: 'working-note', tier: 'user-visible' },
  { site: 'loop.ts working-note demote (routed channel)', role: 'system',
    content: `${INTERNAL_WORKING_NOTE_PREFIX}Not yet, sending now.`,
    kind: 'working-note', tier: 'agent-only' },

  // Lifecycle dividers (agent/tools.ts, routes/agents.ts, routes/chat.ts, routes/system.ts).
  { site: 'new-session divider', role: 'system', content: NEW_SESSION_DIVIDER,
    kind: 'divider', tier: 'user-visible' },
  { site: 'memory/compaction.ts divider', role: 'system',
    content: formatDivider('Memory Compacted (12 messages)'),
    kind: 'divider', tier: 'agent-only' },
  { site: 'google/reauth-notice.ts divider', role: 'system',
    content: formatDivider('Google reconnect needed (do it on the DOJO computer): Settings ▸ Channels ▸ Google'),
    kind: 'divider', tier: 'user-visible' },

  // Outbound routing marker (loop.ts persistRoutingMarker) — raw row hidden, badge derived.
  { site: 'loop.ts persistRoutingMarker', role: 'system',
    content: '[Reply routed via iMessage to Sam]',
    kind: 'routing-marker', tier: 'agent-only' },
  { site: 'loop.ts persistRoutingMarker (legacy form)', role: 'system',
    content: '[SENT VIA IMESSAGE to Sam]',
    kind: 'routing-marker', tier: 'agent-only' },

  // Owner alerts — the allowlist that until now lived ONLY in the dashboard.
  { site: 'scheduler/runner.ts failed-final-run', role: 'system',
    content: `${OWNER_ALERT_HEADS_UP_PREFIX} a scheduled reminder, "water the plants", failed on its final attempt.`,
    kind: 'owner-alert', tier: 'user-visible' },
  { site: 'agent/destructive-gate.ts approval expiry', role: 'system',
    content: `${OWNER_ALERT_HEADS_UP_PREFIX} "Kevin" asked me to approve a sensitive action.`,
    kind: 'owner-alert', tier: 'user-visible' },
  { site: 'tracker/tools.ts project_needs_attention', role: 'system',
    content: `${OWNER_ALERT_PROJECT_ATTENTION_PREFIX} "Launch" is NOT complete: 2 tasks fell.`,
    kind: 'owner-alert', tier: 'user-visible' },
  // …and the same notice AS IT ACTUALLY ARRIVES. Measured at 2f54de3: the only writer of
  // that prefix is `tracker/tools.ts` → `notifyPrimaryAgent` → `insertInterAgentEngineRow`,
  // which is an EVENTS-lane role='user' row. It is a brief to the model, not a bubble, and
  // the lane says so — the owner-alert prefix does not override it. (The in-code comment at
  // tracker/tools.ts claiming this renders in the owner's default chat is stale; recorded in
  // the T8 report, not silently repaired here, because what the owner sees is Sweep E's.)
  { site: 'tracker/notify.ts envelope around the above', role: 'user', lane: 'events',
    content: `[SOURCE: TRACKER TASK UPDATE - automated] ${OWNER_ALERT_PROJECT_ATTENTION_PREFIX} "Launch" is NOT complete.`,
    kind: 'engine-note', tier: 'agent-only' },

  // Engine coordination.
  { site: 'engine-steer.ts persistEngineSteer', role: 'system',
    content: '[Engine hint: you ended with [no-reply], but this message is a direct request.]',
    kind: 'engine-note', tier: 'agent-only' },
  { site: 'loop.ts BOOKKEEPING_NUDGE', role: 'user',
    content: '[Engine note: this was internal bookkeeping.]',
    kind: 'engine-note', tier: 'agent-only' },
  { site: 'tracker/notify.ts assignment', role: 'user',
    content: '[SOURCE: TRACKER TASK ASSIGNMENT - new task] please do X',
    kind: 'engine-note', tier: 'agent-only' },
  { site: 'insertEngineEvent (any lane=events row)', role: 'user', lane: 'events',
    content: 'a bare engine event with no marker at all',
    kind: 'engine-note', tier: 'agent-only' },

  // Peer traffic.
  { site: 'a2a-transport.ts inbound', role: 'user', lane: 'a2a',
    content: '[A2A:QUESTION thread:t1 from:kevin] do you have the file?',
    kind: 'a2a', tier: 'agent-only' },
  { site: 'loop.ts a2a own output', role: 'assistant', lane: 'a2a',
    content: 'Yes, sending it now.', kind: 'a2a', tier: 'agent-only' },

  // Engine-composed assistant text. OR2 / PHASE 4 removes the composers; T8 only has to
  // say honestly that the ENGINE wrote them, which `origin_intent` already records.
  { site: 'loop.ts deliverEngineUserAck', role: 'assistant', originIntent: 'engine_start_ack',
    content: 'On it — starting the backup now.', kind: 'fallback', tier: 'user-visible' },
  { site: 'loop.ts cross-conv send echo', role: 'assistant', originIntent: 'cross_conv_send_echo',
    content: '[Sent via iMessage to Sam]: whats your Delta SkyMiles number?',
    kind: 'fallback', tier: 'user-visible' },
  { site: 'assistant fallback prefix (error text)', role: 'assistant',
    content: "I'm sorry — I'm having trouble reaching the model right now.",
    kind: 'fallback', tier: 'agent-only' },

  // The ordinary conversation.
  { site: 'routes/chat.ts owner message', role: 'user', content: 'what is on my calendar?',
    kind: 'user-text', tier: 'user-visible' },
  { site: 'imessage-bridge.ts inbound', role: 'user',
    content: '[SOURCE: IMESSAGE FROM Sam] running late',
    kind: 'user-text', tier: 'user-visible' },
  { site: 'loop.ts terminal reply', role: 'assistant', content: 'Two meetings, both after lunch.',
    kind: 'agent-text', tier: 'user-visible' },
  { site: 'loop.ts tool-bearing assistant row', role: 'assistant',
    content: JSON.stringify([{ type: 'tool_use', id: 't1', name: 'file_read', input: {} }]),
    kind: 'tool-turn', tier: 'user-visible' },
  { site: 'loop.ts tool result row', role: 'tool', content: '{"ok":true}',
    kind: 'tool-turn', tier: 'agent-only' },
];

describe('every writer literal round-trips the shared classifier', () => {
  for (const c of WRITER_LITERALS) {
    it(`${c.site} → ${c.kind}/${c.tier}`, () => {
      const got = classifyMessageForDisplay({
        role: c.role, content: c.content, lane: c.lane,
        originIntent: c.originIntent ?? null,
      });
      expect(got.kind, `${c.site} kind`).toBe(c.kind);
      expect(got.tier, `${c.site} tier`).toBe(c.tier);
    });
  }

  it('every case lands inside the closed vocabulary', () => {
    for (const c of WRITER_LITERALS) {
      const got = classifyMessageForDisplay({ role: c.role, content: c.content, lane: c.lane });
      expect(DISPLAY_KINDS as readonly string[]).toContain(got.kind);
      expect(DISPLAY_TIERS as readonly string[]).toContain(got.tier);
    }
  });
});

// ── The comma/em-dash class, stated as its own assertion ──

describe('the closed marker has exactly one spelling', () => {
  it('the em-dash form is the one the classifier answers to', () => {
    expect(NO_REPLY_CLOSED_MARKER).toContain('—');
    expect(classifyMessageForDisplay({ role: 'system', content: NO_REPLY_CLOSED_MARKER }))
      .toEqual({ kind: 'no-reply-marker', tier: 'never-shown' });
  });

  it('the COMMA form — the spelling the engine used to write — is NOT recognised', () => {
    // Kept as a live assertion rather than a comment: it is the evidence that the two
    // spellings were genuinely different strings, and it is what makes the fix meaningful
    // rather than cosmetic. Rows written before T8 carry this form and stay unrecognised;
    // their content bytes are never rewritten (cache law).
    const commaForm = '[Agent ended turn without replying, conversation closed]';
    expect(commaForm).not.toBe(NO_REPLY_CLOSED_MARKER);
    expect(classifyMessageForDisplay({ role: 'system', content: commaForm }).kind)
      .not.toBe('no-reply-marker');
  });
});

// ── Fail-closed: a lane can only ever LOWER visibility ──

describe('visibility is earned', () => {
  it('an events-lane row is agent-only whatever its content looks like', () => {
    for (const content of ['plain user text', NEW_SESSION_DIVIDER, `${OWNER_ALERT_HEADS_UP_PREFIX} something`]) {
      expect(classifyMessageForDisplay({ role: 'user', content, lane: 'events' }).tier)
        .toBe('agent-only');
      expect(classifyMessageForDisplay({ role: 'system', content, lane: 'events' }).tier)
        .toBe('agent-only');
    }
  });

  it('an a2a-lane row is agent-only whatever its role', () => {
    for (const role of ['user', 'assistant', 'system', 'tool'] as const) {
      expect(classifyMessageForDisplay({ role, content: 'hello', lane: 'a2a' }).tier)
        .toBe('agent-only');
    }
  });
});

// ── The marker helpers themselves ──

describe('mood marker (17 §C3 — extracted, never rendered)', () => {
  it('parses the last marker and strips every one', () => {
    const text = '((mood: curious)) Interesting. ((mood: success)) That worked.';
    expect(parseMoodMarker(text)).toBe('success');
    expect(stripMoodMarker(text)).toBe('Interesting.  That worked.');
    expect(stripMoodMarker(text)).not.toContain('((mood:');
  });

  it('is a no-op on text that carries none', () => {
    expect(parseMoodMarker('plain reply')).toBeNull();
    expect(stripMoodMarker('plain reply')).toBe('plain reply');
  });

  it('tolerates the spacing and casing the prompt teaches', () => {
    expect(parseMoodMarker('((mood: SYMPATHETIC)) ok')).toBe('sympathetic');
    expect(parseMoodMarker('((  mood :  happy  )) ok')).toBe('happy');
  });
});

describe('[no-reply] sentinel', () => {
  it('recognises the bare form with or without markdown wrappers', () => {
    expect(isBareNoReplySentinel('[no-reply]')).toBe(true);
    expect(isBareNoReplySentinel('  `[no-reply]`  ')).toBe(true);
    expect(isBareNoReplySentinel('**[NO-REPLY]**')).toBe(true);
    expect(isBareNoReplySentinel('done. [no-reply]')).toBe(false);
  });

  it('strips a sentinel wherever it survived into text', () => {
    expect(stripNoReplySentinel('All set. [no-reply]')).toBe('All set.');
    expect(stripNoReplySentinel('All set.\n\n`[no-reply]`')).toBe('All set.');
    expect(stripNoReplySentinel('nothing here')).toBe('nothing here');
  });
});

describe('working-note and owner-alert matchers', () => {
  it('parseWorkingNote splits the prefix from the note', () => {
    expect(parseWorkingNote(`${WORKING_NOTE_PREFIX}checking`)).toEqual({ text: 'checking', internal: false });
    expect(parseWorkingNote(`${INTERNAL_WORKING_NOTE_PREFIX}checking`)).toEqual({ text: 'checking', internal: true });
    expect(parseWorkingNote('an ordinary system row')).toBeNull();
  });

  it('isOwnerAlertSystemNote sees through notifyPrimaryAgent\'s envelope', () => {
    expect(isOwnerAlertSystemNote(`${OWNER_ALERT_HEADS_UP_PREFIX} a thing failed`)).toBe(true);
    expect(isOwnerAlertSystemNote(`[SOURCE: TRACKER TASK UPDATE - automated] ${OWNER_ALERT_PROJECT_ATTENTION_PREFIX} x`)).toBe(true);
    expect(isOwnerAlertSystemNote('[SOURCE: TRACKER TASK UPDATE - automated] "Launch" completed')).toBe(false);
    expect(isOwnerAlertSystemNote('[VALIDATION CHECK] task 3f2a…')).toBe(false);
  });
});
