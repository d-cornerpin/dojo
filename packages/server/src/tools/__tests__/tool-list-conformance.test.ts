// ════════════════════════════════════════
// Tool-list conformance (2026-07-08 defect-class tripwire)
//
// Kills a whole defect CLASS: hand-maintained lists/maps of tool NAMES that
// freeze a snapshot of the tool surface and silently drift as tools are added
// (every _ms variant, user_ twin, office/onedrive tool falls out). Two failures
// this class caused in the wild: the close-out machinery missed calendar_create_ms
// (a finished job ghost-re-announced 100 minutes later), and drifted google
// write/read validator maps left drive_upload + sheets_append 100% dead.
//
// This test does NOT try to eliminate every hand list (some legitimately encode
// exceptions a classifier can't know, e.g. verification tiers or a security
// deny-surface). Instead it PINS the survivors:
//   (a) every name in a surviving hand list must resolve to a REAL tool, so a
//       rename/typo (or a phantom that was never a tool) fails the build the
//       moment it happens, and
//   (b) the coverage-critical DERIVED predicates behave across the families that
//       drift (google / microsoft / _ms / user_ / office / onedrive), so the
//       conversions away from hand lists (thrash-progress, delivery, send-bubble)
//       can never silently regress.
//
// Import approach / the circular-import trap: agent/tools.ts has a module-init
// circular import with the google/microsoft tool modules (importing it standalone
// hangs). This test therefore imports the PLAIN DATA module tools/categories.ts
// as the tool registry (the same surface the V5 visibility test trusts) plus the
// LEAF/type-only hand-list modules, and never touches agent/tools.ts. The release
// gate (deploy/check-tool-conformance.mjs) runs the identical assertions against
// the built dist.
// ════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import { classifyTool, channelOfSendTool } from '@dojo/shared';
import { TOOL_CATEGORIES } from '../categories.js';

// Surviving hand lists, imported from the light modules that own them (all
// type-only / leaf imports, so none drags in the circular agent/tools.ts).
import {
  SEARCH_TOOLS,
  GENERATION_TOOLS,
  COORDINATION_TOOLS,
  MUTATING_TOOLS,
} from '../../agent/v2/classifiers/loop.js';
import { STRUCTURING_TOOLS } from '../../agent/v2/classifiers/hoarding.js';
import { TOOL_CATEGORY } from '../../agent/v2/classifiers/concurrency.js';
import { SELF_ACKNOWLEDGING_TOOLS } from '../../agent/v2/classifiers/ack.js';
import { RECEIPT_TOOLS, RECEIPT_EXEMPT } from '../../receipts/store.js';
import { SEND_TO_PEOPLE, SEND_TO_PEOPLE_NA, USER_TWINNED_SEND_PREFIXES } from '../../agent/sensei-policy.js';

// ── The reference registry ──
// categories.ts is the canonical, plain-data list of every base tool grouped by
// category. The user_-prefixed twins (one per Google/Microsoft tool, acting on
// the owner's personal account) are generated at runtime and are NOT listed in
// categories, so a user_ name resolves by stripping the prefix and checking the
// base tool exists.
const REGISTRY = new Set(TOOL_CATEGORIES.flatMap((c) => c.tools));
function isRealTool(name: string): boolean {
  if (REGISTRY.has(name)) return true;
  if (name.startsWith('user_') && REGISTRY.has(name.slice(5))) return true;
  return false;
}

// Every surviving hand list, as {label, names}. Record maps contribute their KEYS.
const HAND_LISTS: Array<{ label: string; names: string[] }> = [
  { label: 'loop.SEARCH_TOOLS (signature: query is identity)', names: [...SEARCH_TOOLS] },
  { label: 'loop.GENERATION_TOOLS (signature: prompt is identity)', names: [...GENERATION_TOOLS] },
  { label: 'loop.COORDINATION_TOOLS (signature: payload is identity)', names: [...COORDINATION_TOOLS] },
  { label: 'loop.MUTATING_TOOLS (signature: content is identity)', names: [...MUTATING_TOOLS] },
  // hoarding.LOADING_TOOLS was RETIRED 2026-07-08: the anti-hoarding counter now
  // ticks on measured result SIZE (LOADING_RESULT_MIN_TOKENS), not a curated
  // reader name-set, so there is no reader list left to drift. STRUCTURING_TOOLS
  // survives as the small curated durable-write satisfier set and is pinned for
  // phantoms only (an omission there merely over-nudges; see its docstring for
  // why it does NOT earn full registry-exhaustive accounting).
  { label: 'hoarding.STRUCTURING_TOOLS', names: [...STRUCTURING_TOOLS] },
  { label: 'concurrency.TOOL_CATEGORY (keys)', names: Object.keys(TOOL_CATEGORY) },
  { label: 'ack.SELF_ACKNOWLEDGING_TOOLS', names: [...SELF_ACKNOWLEDGING_TOOLS] },
  { label: 'receipts.RECEIPT_TOOLS (keys)', names: Object.keys(RECEIPT_TOOLS) },
  { label: 'sensei.SEND_TO_PEOPLE', names: [...SEND_TO_PEOPLE] },
];

describe('tool-list conformance — surviving hand lists reference real tools', () => {
  it('the registry is populated (guards against an empty/partial categories import)', () => {
    expect(REGISTRY.size).toBeGreaterThan(100);
  });

  for (const { label, names } of HAND_LISTS) {
    it(`${label}: every member is a real tool`, () => {
      const phantom = names.filter((n) => !isRealTool(n));
      expect(phantom, `phantom tool name(s) in ${label}: ${phantom.join(', ')}`).toEqual([]);
    });
  }
});

describe('tool-list conformance — coverage-critical derived predicates', () => {
  // The thrash-progress predicate is now classifyTool(name) === 'effectful-action'
  // (was the ~10-name MUTATING_TOOLS hand list with zero _ms/user_/upload
  // coverage). The close-out "did external side-effect this turn" predicate is the
  // same. This canary spans exactly the families that used to fall out.
  const EFFECTFUL_CANARY = [
    'calendar_create',
    'calendar_create_ms', // the exact miss that ghost-re-announced on prod
    'calendar_update_ms',
    'calendar_delete_ms',
    'user_gmail_send',
    'user_calendar_create',
    'drive_upload',
    'onedrive_upload',
    'sheets_append', // the exact tool a drifted validator map left 100% dead
    'office_create_word_document',
    'teams_send_channel_message',
    'imessage_send',
    'file_write',
  ];
  for (const name of EFFECTFUL_CANARY) {
    it(`classifyTool('${name}') === 'effectful-action' (progress / side-effect coverage)`, () => {
      expect(classifyTool(name)).toBe('effectful-action');
    });
  }

  const RETRIEVAL_CANARY = ['gmail_search', 'calendar_agenda_ms', 'outlook_read', 'onedrive_read', 'user_gmail_search'];
  for (const name of RETRIEVAL_CANARY) {
    it(`classifyTool('${name}') === 'retrieval'`, () => {
      expect(classifyTool(name)).toBe('retrieval');
    });
  }

  it("classifyTool bookkeeping/delivery anchors hold", () => {
    expect(classifyTool('tracker_update_status')).toBe('bookkeeping');
    expect(classifyTool('send_to_agent')).toBe('bookkeeping');
    expect(classifyTool('show_to_user')).toBe('delivery');
  });

  // Every name in MUTATING_TOOLS (the signature content-field carve-out) must ALSO
  // classify effectful-action, so the split "prose-carve-out ⊂ progress set" stays
  // coherent, no member is a content-bearing write that classifyTool would miss.
  it('MUTATING_TOOLS is a strict subset of effectful-action (coherent split)', () => {
    const notEffectful = [...MUTATING_TOOLS].filter((n) => classifyTool(n) !== 'effectful-action');
    expect(notEffectful, `MUTATING_TOOLS members not effectful: ${notEffectful.join(', ')}`).toEqual([]);
  });
});

describe('tool-list conformance — SEND_TO_PEOPLE covers every channel send (security surface)', () => {
  // The Trainer/Healer comms deny-surface is hand-picked (it includes non-send
  // comms tools no classifier flags), but it MUST cover every human-channel send.
  // Derive the send set from the canonical channelOfSendTool over the whole
  // registry: a NEW send tool that ships without being added to SEND_TO_PEOPLE
  // fails here instead of silently under-blocking the Trainer.
  const sendTools = [...REGISTRY].filter((n) => channelOfSendTool(n) !== null).sort();

  it('there is at least one channel-send tool to check', () => {
    expect(sendTools.length).toBeGreaterThan(5);
  });

  it('every channelOfSendTool-recognized send is in SEND_TO_PEOPLE', () => {
    const deny = new Set(SEND_TO_PEOPLE);
    const uncovered = sendTools.filter((n) => !deny.has(n));
    expect(uncovered, `channel sends missing from SEND_TO_PEOPLE: ${uncovered.join(', ')}`).toEqual([]);
  });
});

// ── Registry-EXHAUSTIVE accounting (anti-omission, 2026-07-08) ──
// Existence checks (above) stop a typo/rename. These stop the mirror defect: a
// curated list MISSING a tool it should have. For each coverage-critical list,
// every registry tool must be a member, matched by a documented derivation, or
// named in a not-applicable ledger that lives NEXT TO the list in source. A new
// tool nobody classified then fails here (and the release gate) with a message
// naming the tool and the list owing a decision. Cosmetic lists (icons/labels)
// are intentionally NOT forced exhaustive, their fallbacks are the correct design.

// Match a name against a ledger of exact names or family-prefix globs (trailing
// '*'). Ledgers are Record<pattern, reason>; the reason is the developer-facing
// justification, unused by the match.
function matchesLedger(name: string, ledger: Readonly<Record<string, string>>): boolean {
  for (const pattern of Object.keys(ledger)) {
    if (pattern.endsWith('*')) {
      if (name.startsWith(pattern.slice(0, -1))) return true;
    } else if (pattern === name) {
      return true;
    }
  }
  return false;
}

describe('tool-list conformance — SEND_TO_PEOPLE is registry-exhaustive (anti-omission)', () => {
  const send = new Set(SEND_TO_PEOPLE);
  const baseTools = [...REGISTRY];

  it('every base registry tool is either denied in SEND_TO_PEOPLE or exempt-with-reason', () => {
    const unclassified = baseTools.filter((n) => !send.has(n) && !matchesLedger(n, SEND_TO_PEOPLE_NA));
    expect(
      unclassified,
      `\nUNCLASSIFIED TOOL(S) — no comms decision: ${unclassified.join(', ')}\n` +
      `Each must be added to SEND_TO_PEOPLE (if it reaches a person on an owner channel: ` +
      `email / Teams / SMS / iMessage / voice) OR to the SEND_TO_PEOPLE_NA ledger with a ` +
      `one-line reason, both in packages/server/src/agent/sensei-policy.ts. ` +
      `Leaving it unlisted silently under-blocks the Trainer/Healer.`,
    ).toEqual([]);
  });

  it('every denied base send in a user_-twinned family also denies its user_ twin', () => {
    const missingTwins = [...send].filter(
      (n) =>
        !n.startsWith('user_') &&
        USER_TWINNED_SEND_PREFIXES.some((p) => n.startsWith(p)) &&
        !send.has(`user_${n}`),
    );
    expect(
      missingTwins,
      `\nuser_ SEND TWIN(S) MISSING from SEND_TO_PEOPLE: ${missingTwins.map((n) => `user_${n}`).join(', ')}\n` +
      `The base send is denied but its owner-account (user_) twin is not, so the ` +
      `Trainer/Healer can send from the OWNER's personal account. Add each user_ twin ` +
      `to SEND_TO_PEOPLE in packages/server/src/agent/sensei-policy.ts.`,
    ).toEqual([]);
  });

  it('the not-applicable ledger has no dead entries (exact names must be real tools)', () => {
    const deadExact = Object.keys(SEND_TO_PEOPLE_NA)
      .filter((p) => !p.endsWith('*') && !isRealTool(p));
    expect(deadExact, `SEND_TO_PEOPLE_NA exact entries that are not real tools: ${deadExact.join(', ')}`).toEqual([]);
  });
});

describe('tool-list conformance — RECEIPT_TOOLS covers the whole comms-send surface (anti-omission)', () => {
  // Domain = every SEND_TO_PEOPLE member. Each must carry a verification tier in
  // RECEIPT_TOOLS or a reason in RECEIPT_EXEMPT, so a new comms send can't ship
  // without a delivery-verification decision.
  it('every SEND_TO_PEOPLE member has a receipt tier or an exemption reason', () => {
    const owing = SEND_TO_PEOPLE.filter(
      (n) => !(n in RECEIPT_TOOLS) && !matchesLedger(n, RECEIPT_EXEMPT),
    );
    expect(
      owing,
      `\nCHANNEL-SEND TOOL(S) with no receipt tier or exemption: ${owing.join(', ')}\n` +
      `Add a tier to RECEIPT_TOOLS (how the send is verified: provider-id=1, refetch=2, ` +
      `exit-code=3) OR a reason to RECEIPT_EXEMPT, both in packages/server/src/receipts/store.ts. ` +
      `Without one, the dev harness can't synthesize this send's receipt and the receipt ` +
      `gate goes untested for it.`,
    ).toEqual([]);
  });

  it('RECEIPT_TOOLS keys and RECEIPT_EXEMPT exact entries are real tools', () => {
    const deadTier = Object.keys(RECEIPT_TOOLS).filter((n) => !isRealTool(n));
    const deadExempt = Object.keys(RECEIPT_EXEMPT).filter((p) => !p.endsWith('*') && !isRealTool(p));
    expect(deadTier, `RECEIPT_TOOLS keys not real tools: ${deadTier.join(', ')}`).toEqual([]);
    expect(deadExempt, `RECEIPT_EXEMPT exact entries not real tools: ${deadExempt.join(', ')}`).toEqual([]);
  });
});
