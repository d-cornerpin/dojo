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
// loop.SEARCH_TOOLS / GENERATION_TOOLS / COORDINATION_TOOLS / MUTATING_TOOLS were
// four hand lists here until 2026-09-22. THE MECHANISM THEY SERVED IS DELETED, not
// relocated: `canonicalToolSignature` no longer strips a prose-field allow-list, so
// there is no carve-out set to keep a tool in and no list left to police. See the
// header of `agent/v2/classifiers/loop.ts` for the owner ruling and the production
// defect (five `user_gmail_search` date ranges collapsing to one signature —
// a runtime-generated twin that no set named and that the registry-exhaustive scan
// in section (e) below could not see, because the twins are not in `TOOL_CATEGORIES`).
import { STRUCTURING_OPS } from '../../agent/v2/classifiers/hoarding.js';
import { canonicalToolSignature } from '../../agent/v2/classifiers/loop.js';
import { TOOL_CATEGORY, WORK_OP_CONCURRENCY } from '../../agent/v2/classifiers/concurrency.js';
import { isWorkOp } from '../work-verbs.js';
import { RECEIPT_TOOLS, RECEIPT_EXEMPT } from '../../receipts/store.js';
import { SEND_TO_PEOPLE, SEND_TO_PEOPLE_NA, USER_TWINNED_SEND_PREFIXES } from '../../agent/sensei-policy.js';

// ── The reference registry ──
// categories.ts is the canonical, plain-data list of every base tool grouped by
// category. The user_-prefixed twins (one per Google/Microsoft tool, acting on
// the owner's personal account) are generated at runtime and are NOT listed in
// categories, so a user_ name resolves by stripping the prefix and checking the
// base tool exists.
const REGISTRY = new Set(TOOL_CATEGORIES.flatMap((c) => c.tools));
// PHASE-2 T8V: a hand list may now name an OPERATION (`work_update:status`) as
// well as a tool. That is not a loosening — it is the same anti-phantom rule
// applied to the new key space: an op id must be one of the 23 declared in
// tools/work-verbs.ts, so `work_update:staus` still fails the build exactly as
// `tracker_update_staus` used to. A bare work VERB in one of these behavioural
// lists is itself a phantom now (it names six operations at once, which is the
// ambiguity the collapse created), and `isWorkOp` rejects it.
function isRealTool(name: string): boolean {
  if (name.includes(':')) return isWorkOp(name);
  if (REGISTRY.has(name)) return true;
  if (name.startsWith('user_') && REGISTRY.has(name.slice(5))) return true;
  return false;
}

// Every surviving hand list, as {label, names}. Record maps contribute their KEYS.
const HAND_LISTS: Array<{ label: string; names: string[] }> = [
  // The four loop-signature sets were RETIRED 2026-09-22 with the prose allow-list
  // they existed to patch (see the import block above). Nothing replaces them: a
  // signature that carries every argument has no set to be absent from.
  // hoarding.LOADING_TOOLS was RETIRED 2026-07-08: the anti-hoarding counter now
  // ticks on measured result SIZE (LOADING_RESULT_MIN_TOKENS), not a curated
  // reader name-set, so there is no reader list left to drift. STRUCTURING_TOOLS
  // survives as the small curated durable-write satisfier set and is pinned for
  // phantoms only (an omission there merely over-nudges; see its docstring for
  // why it does NOT earn full registry-exhaustive accounting).
  { label: 'hoarding.STRUCTURING_OPS', names: [...STRUCTURING_OPS] },
  { label: 'concurrency.TOOL_CATEGORY (keys)', names: Object.keys(TOOL_CATEGORY) },
  { label: 'concurrency.WORK_OP_CONCURRENCY (keys)', names: Object.keys(WORK_OP_CONCURRENCY) },
  // `ack.SELF_ACKNOWLEDGING_TOOLS` was a hand list here until UX-REPAIR T71b.
  // It and its only reader, `ackInjector`, are DELETED: the classifier was
  // disabled 2026-05-04 (`v2/loop.ts` said so in as many words) and nothing but
  // this line and its own unit test had imported either since — so the set was a
  // second ack authority that could suppress nothing and a phantom-guard for a
  // list no live code read.
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

  // The MUTATING_TOOLS coherence bound was RETIRED 2026-09-22 with the set. It
  // asked "is every member of the content-identity carve-out a tool whose effect
  // class makes that plausible" — a question that only exists when membership of a
  // list decides whether an argument survives into a signature. It no longer does.
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

  // ── Declared-tier lock (lanes & lineage P7b) ──
  // The comms-to-people decision is now DECLARED at the tool definition site
  // (`reachesPeople: true` on the ToolDefinition), not only remembered in the
  // leaf list. sensei-policy.ts stays the runtime set (it is a no-import leaf by
  // design and cannot derive from the registry), so this test pins two-way
  // equality between the declarations and the list's base names: a declaration
  // without a list entry OR a list entry without a declaration fails the build
  // naming the tool. user_ twins inherit the flag via the twin-generation
  // spread and are pinned by the twin-parity check above. Twin of section (f)
  // in deploy/check-tool-conformance.mjs (which scans the built dist).
  it('reachesPeople declarations and SEND_TO_PEOPLE base names are equal sets', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const files: string[] = [];
    (function walk(d: string) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const fp = path.join(d, e.name);
        if (e.isDirectory()) { if (!fp.includes('__tests__') && !fp.includes('node_modules')) walk(fp); }
        else if (e.name.endsWith('.ts')) files.push(fp);
      }
    })(srcRoot);
    const declared = new Set<string>();
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      const nameRe = /name:\s*['"]([a-z0-9_]+)['"]/g;
      const marks: Array<{ name: string; i: number }> = [];
      let mm: RegExpExecArray | null;
      while ((mm = nameRe.exec(text))) marks.push({ name: mm[1], i: mm.index });
      for (let k = 0; k < marks.length; k++) {
        if (!REGISTRY.has(marks[k].name)) continue;
        const end = k + 1 < marks.length ? marks[k + 1].i : Math.min(text.length, marks[k].i + 9000);
        const slice = text.slice(marks[k].i, end);
        if (!slice.includes('input_schema')) continue;
        if (/reachesPeople:\s*true/.test(slice)) declared.add(marks[k].name);
      }
    }
    const listBases = new Set(SEND_TO_PEOPLE.filter((n) => !n.startsWith('user_')));
    const undeclared = [...listBases].filter((n) => !declared.has(n)).sort();
    const unlisted = [...declared].filter((n) => !listBases.has(n)).sort();
    expect(declared.size, 'reachesPeople declaration scan found nothing; scan pattern broken?').toBeGreaterThanOrEqual(5);
    expect(
      undeclared,
      `SEND_TO_PEOPLE base name(s) with no reachesPeople declaration on the tool definition: ${undeclared.join(', ')}. ` +
      `Add \`reachesPeople: true\` to each definition so the decision lives at the definition site.`,
    ).toEqual([]);
    expect(
      unlisted,
      `tool(s) declaring reachesPeople: true but missing from SEND_TO_PEOPLE: ${unlisted.join(', ')}. ` +
      `Add each to SEND_TO_PEOPLE in packages/server/src/agent/sensei-policy.ts (and its user_ twin if the family is twinned).`,
    ).toEqual([]);
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
  // ── Loop-signature identity, 2026-09-22: THE ACCOUNTING IS GONE BECAUSE THE
  //    THING IT ACCOUNTED FOR IS GONE ──
  // What stood here was a derivation SCAN: walk every tool definition in src,
  // find the ones carrying a free-text `content|text|message|payload|prompt` arg,
  // and demand each be named in a carve-out set or in a four-entry ack ledger,
  // because `canonicalToolSignature` would otherwise strip that arg. It had a
  // structural blind spot that put the defect into production: it iterated
  // `REGISTRY` — the names literally declared in `tools/categories.ts` — and the
  // `user_`-prefixed twins are minted at RUNTIME, so no twin could ever be a hit
  // and no twin was ever in a set. `user_gmail_search` lost its `query`, five
  // distinct date-range searches became one signature, and the engine refused the
  // work while asserting the model already had the result.
  //
  // The scan is replaced by the invariant it was approximating, asked DIRECTLY of
  // the function and over the twins as well: no argument key is ever dropped.
  // There is nothing to classify, so there is nothing to omit.
  it('⚠ THE LOOP SIGNATURE DROPS NO ARGUMENT, FOR ANY TOOL OR ITS user_ TWIN', () => {
    const args: Record<string, unknown> = {
      // the 13 names v1's PROSE_FIELDS allow-list dropped, plus ordinary args
      caption: 'c', message: 'm', content: 'k', text: 't', payload: 'p',
      summary: 's', description: 'd', query: 'q', reason: 'r', note: 'n',
      notes: 'nn', change_summary: 'cs', instructions: 'i',
      prompt: 'pr', path: '/x', max_results: 40,
    };
    const keys = Object.keys(args);
    const everyName = [...REGISTRY, ...[...REGISTRY].map((n) => `user_${n}`)];
    expect(everyName.length).toBeGreaterThan(200);
    const dropped: string[] = [];
    for (const name of everyName) {
      const sig = canonicalToolSignature(name, args);
      for (const k of keys) if (!sig.includes(`"${k}":`)) dropped.push(`${name}.${k}`);
    }
    expect(
      dropped.slice(0, 20),
      `loop signature dropped argument(s): ${dropped.slice(0, 20).join(', ')}${dropped.length > 20 ? ` (+${dropped.length - 20} more)` : ''}. ` +
      `Distinct calls then collapse to one signature, the gate refuses real work, and its message asserts ` +
      `"you already have the result from the first call" — which is only true when the match is full-args identity.`,
    ).toEqual([]);
  });
});
