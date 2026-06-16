// R9 inventory lock — the §3 inventory (DOJO-PROMPT-REGISTRY-PLAN.md) as a test.
// Every injection the assembler can produce is a registered entry; this asserts
// the complete set is present and pins it as a golden so any add/remove of an
// injection shows up as a reviewable diff (and a missing entry — a slot that
// would silently vanish — fails the build).
//
// Importing the registry module triggers entries.ts registration (side effect).

import { describe, it, expect } from 'vitest';
import '../entries.js';
import { registeredIds, getSystemEntries, getMessageEntries } from '../registry.js';

// The complete §3 inventory (23 system slots + the weak-hint rawAppend = 24
// system entries; 5 message entries). Keep in sync with DOJO-PROMPT-REGISTRY-PLAN
// §3 + the contract doc.
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
  'sys.technique-weak-hint',
];

const EXPECTED_MESSAGE = [
  'msg.tool-note',
  'msg.pending-nudge',
  'msg.context-gap',
  'msg.tracker-notif',
  'msg.technique-strong',
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
