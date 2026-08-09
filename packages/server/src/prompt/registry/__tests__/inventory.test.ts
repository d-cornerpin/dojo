// R9 inventory lock — the §3 inventory (DOJO-PROMPT-REGISTRY-PLAN.md) as a test.
// Every injection the assembler can produce is a registered entry; this asserts
// the complete set is present and pins it as a golden so any add/remove of an
// injection shows up as a reviewable diff (and a missing entry — a slot that
// would silently vanish — fails the build).
//
// FA-PT3: the vitest root is skipped in the release gate, so THIS file never
// runs and had gone stale on both sides (it required a dead sys.technique-weak-hint
// and omitted msg.technique-weak/turn-context/current-time). The ENFORCED roster
// lock is now dev-test-tools/check-prompt-inventory.mjs (a standalone tsx runner
// wired into the release gate; it pins the exact ids AND slot order of both
// registries). This test is kept, synced to the live roster, as a fast local
// mirror for anyone who does run vitest; the standalone gate is authoritative.
//
// Importing the registry module triggers entries.ts registration (side effect).

import { describe, it, expect } from 'vitest';
import '../entries.js';
import { registeredIds, getSystemEntries, getMessageEntries } from '../registry.js';

// The complete live inventory, in canonical slot order: 24 system entries, 8
// message entries. Keep in sync with entries.ts (and check-prompt-inventory.mjs).
const EXPECTED_SYSTEM = [
  'sys.reply-destination',
  'sys.channel-landscape',
  'sys.phone-conduct',
  'sys.time',
  'sys.vision-cap',
  'sys.identity',
  'sys.tools',
  'sys.user-profile',
  'sys.precedence-ladder',
  'sys.visibility',
  'sys.pm-awareness',
  'sys.trainer-awareness',
  'sys.healer-awareness',
  'sys.compaction-continuity',
  'sys.message-sources',
  'sys.google-access',
  'sys.ms-access',
  'sys.integration-reconnect',
  'sys.group',
  'sys.techniques-index',
  'sys.techniques-draft',
  'sys.techniques-equipped',
  'sys.runtime',
  'sys.voice-conduct',
];

const EXPECTED_MESSAGE = [
  'msg.technique-strong',
  'msg.technique-weak',
  'msg.context-gap',
  // PHASE-3 T3: 'msg.tracker-notif' STRIPPED (RULING P3-R1 item 2) — its injector died in
  // `d00f270` and the requirement is owned by `tracker/notify.ts`'s persisted, broadcast,
  // waking notice. Removed from the lock rather than left as a registered-never-injected
  // entry, which is the shape T1's golden caught.
  // F9 (2026-07-08): explicit-delegation engine hint, slot 1550 (the retired
  // TrackerNotif number was 1500).
  'msg.delegation-hint',
  'msg.pending-nudge',
  'msg.tool-note',
  'msg.turn-context',
  // PHASE-3 T7: THE DELIVERIES LANE, slot 1860 — what this agent has already sent the
  // counterparty, read from the `deliveries` rows by `memory/deliveries-lane.ts`. It takes
  // over from the registry-exempt `engine.pending-question` push AND from the
  // cross-conversation echo ROW duplication that push used to defer to (T7 Step 2 strips
  // the rows). Volatile by shape, so it sits past the 1850 boundary and before peer-status.
  'msg.deliveries',
  // SWEEP CORE-2 item 4: THE RECALL LANE, slot 1870 — per-message semantic recall and the
  // conclusions it carries from the migration-113 answer stamps (`memory/recall-lane.ts`).
  // It was a `fitLanes` candidate at MessageSlot.RelevantMemory = 400 with no registry entry
  // at all, which is how a lane whose content changes with the live ask came to sit ahead of
  // the fresh tail. Between deliveries and peer-status, past the 1850 boundary.
  'msg.relevant-memory',
  // Live peer statuses in the volatile lane (2026-07-16 cache finding): the
  // cached group roster carries names only; idle/working churn lands here.
  'msg.peer-status',
  'msg.current-time',
];

describe('R9 — registry inventory lock', () => {
  it('every expected §3 entry id is registered', () => {
    const ids = new Set(registeredIds());
    for (const id of [...EXPECTED_SYSTEM, ...EXPECTED_MESSAGE]) {
      expect(ids.has(id), `missing registry entry: ${id}`).toBe(true);
    }
  });

  it('has no UNEXPECTED entries (pins the inventory; add new ids here)', () => {
    const expected = new Set([...EXPECTED_SYSTEM, ...EXPECTED_MESSAGE]);
    const extra = registeredIds().filter((id) => !expected.has(id));
    expect(extra, `unexpected registry entries — update the inventory: ${extra.join(', ')}`).toEqual([]);
  });

  it('system registry matches the pinned roster AND order (add/remove/reorder fails)', () => {
    expect(getSystemEntries().map((e) => e.id)).toEqual(EXPECTED_SYSTEM);
  });

  it('message registry matches the pinned roster AND order (add/remove/reorder fails)', () => {
    expect(getMessageEntries().map((e) => e.id)).toEqual(EXPECTED_MESSAGE);
  });

  it('system entries are slot-sorted (canonical assembly order)', () => {
    const slots = getSystemEntries().map((e) => e.slot as number);
    const sorted = [...slots].sort((a, b) => a - b);
    expect(slots).toEqual(sorted);
  });

  it('every entry has a non-empty reason (preserve-the-reason)', () => {
    for (const e of [...getSystemEntries(), ...getMessageEntries()]) {
      expect(e.reason.length, `entry ${e.id} has no reason`).toBeGreaterThan(10);
    }
  });
});
