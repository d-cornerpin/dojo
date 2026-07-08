#!/usr/bin/env node
// Release-time tool-list conformance gate (2026-07-08 defect-class tripwire).
//
// Kills a defect CLASS: hand-maintained lists/maps of tool NAMES that freeze a
// snapshot of the tool surface and silently drift as tools ship (every _ms
// variant, user_ twin, office/onedrive tool falls out). Proven consequences: a
// close-out list that missed calendar_create_ms ghost-re-announced a finished
// job 100 minutes later; drifted google validator maps left drive_upload +
// sheets_append 100% dead. This gate refuses the release when any SURVIVING hand
// list references a nonexistent tool OR the coverage-critical DERIVED
// classifications regress. It is CHEAP and must run on EVERY cut (normal AND
// --skip-behavioral-gate); it is never skippable.
//
// This is the standalone twin of packages/server/src/tools/__tests__/
// tool-list-conformance.test.ts, same assertions, run at release time.
//
// Import approach / the circular-import trap: agent/tools.ts has a module-init
// circular import with the google/microsoft tool modules, so importing it
// standalone HANGS. This gate never touches it. It reads the BUILT dist (like
// deploy/check-prefix-determinism.mjs) and imports only:
//   - @dojo/shared visibility.js  (self-contained, type-only deps) — the
//     canonical classifyTool + channelOfSendTool,
//   - server dist tools/categories.js (plain data) — the tool registry,
//   - the leaf/type-only hand-list modules (loop/hoarding/concurrency/ack
//     classifiers, receipts/store, sensei-policy).
// None of those has a VALUE @dojo/shared import, so they all load cleanly under
// plain node. release.sh runs `npm run build:package` before the gates, so the
// dist is current at gate time; a stale/missing dist fails loudly below.
//
// Self-contained (NO dev-instrument imports) so it survives the packaged-build
// dev-instrument ship-gate grep in release.sh.
//
// Usage: node check-tool-conformance.mjs [packages-base-dir]
//   packages-base-dir defaults to <repo>/packages.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const PKG_BASE = process.argv[2] ? path.resolve(process.argv[2]) : path.join(REPO_ROOT, 'packages');

function fail(msg) {
  console.error(`  ✗ tool-list conformance gate: ${msg}`);
  process.exit(1);
}
const impErrs = [];
async function imp(rel) {
  try {
    return await import(pathToFileURL(path.join(PKG_BASE, rel)).href);
  } catch (err) {
    impErrs.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

const shared = await imp('shared/dist/visibility.js');
const cats = await imp('server/dist/tools/categories.js');
const loop = await imp('server/dist/agent/v2/classifiers/loop.js');
const hoarding = await imp('server/dist/agent/v2/classifiers/hoarding.js');
const concurrency = await imp('server/dist/agent/v2/classifiers/concurrency.js');
const ack = await imp('server/dist/agent/v2/classifiers/ack.js');
const receipts = await imp('server/dist/receipts/store.js');
const sensei = await imp('server/dist/agent/sensei-policy.js');

if (impErrs.length) {
  fail(
    `could not import the built modules (run \`npm run build\` first?):\n    ` +
    impErrs.join('\n    '),
  );
}

const { classifyTool, channelOfSendTool } = shared;
const { TOOL_CATEGORIES } = cats;
if (typeof classifyTool !== 'function' || typeof channelOfSendTool !== 'function' || !Array.isArray(TOOL_CATEGORIES)) {
  fail('the built modules did not export the expected symbols (classifyTool / channelOfSendTool / TOOL_CATEGORIES).');
}

// ── Reference registry (categories base names + user_ twin rule) ──
const REGISTRY = new Set(TOOL_CATEGORIES.flatMap((c) => c.tools));
if (REGISTRY.size < 100) fail(`tool registry looks empty/partial (${REGISTRY.size} names) — categories import is wrong.`);
const isRealTool = (name) =>
  REGISTRY.has(name) || (name.startsWith('user_') && REGISTRY.has(name.slice(5)));

// ── (a) every surviving hand list references a real tool ──
const HAND_LISTS = [
  ['loop.SEARCH_TOOLS', [...loop.SEARCH_TOOLS]],
  ['loop.GENERATION_TOOLS', [...loop.GENERATION_TOOLS]],
  ['loop.COORDINATION_TOOLS', [...loop.COORDINATION_TOOLS]],
  ['loop.MUTATING_TOOLS', [...loop.MUTATING_TOOLS]],
  // hoarding.LOADING_TOOLS retired 2026-07-08 (anti-hoarding now counts measured
  // result SIZE, not a reader name-set). STRUCTURING_TOOLS survives, phantom check only.
  ['hoarding.STRUCTURING_TOOLS', [...hoarding.STRUCTURING_TOOLS]],
  ['concurrency.TOOL_CATEGORY', Object.keys(concurrency.TOOL_CATEGORY)],
  ['ack.SELF_ACKNOWLEDGING_TOOLS', [...ack.SELF_ACKNOWLEDGING_TOOLS]],
  ['receipts.RECEIPT_TOOLS', Object.keys(receipts.RECEIPT_TOOLS)],
  ['sensei.SEND_TO_PEOPLE', [...sensei.SEND_TO_PEOPLE]],
];
const listErrors = [];
for (const [label, names] of HAND_LISTS) {
  if (!Array.isArray(names) || names.length === 0) {
    listErrors.push(`${label}: could not read the list (import/shape problem).`);
    continue;
  }
  const phantom = names.filter((n) => !isRealTool(n));
  if (phantom.length) listErrors.push(`${label}: phantom tool name(s): ${phantom.join(', ')}`);
}

// ── (b) coverage-critical derived predicates ──
// The thrash-progress + close-out "did a side effect this turn" predicates are
// now classifyTool === 'effectful-action' (was a hand list missing every
// _ms/user_/upload variant). This canary spans exactly the families that drift.
const CANARY = [
  ['calendar_create', 'effectful-action'],
  ['calendar_create_ms', 'effectful-action'], // the exact prod miss
  ['calendar_update_ms', 'effectful-action'],
  ['calendar_delete_ms', 'effectful-action'],
  ['user_gmail_send', 'effectful-action'],
  ['user_calendar_create', 'effectful-action'],
  ['drive_upload', 'effectful-action'],
  ['onedrive_upload', 'effectful-action'],
  ['sheets_append', 'effectful-action'], // the exact tool a drifted map left dead
  ['office_create_word_document', 'effectful-action'],
  ['teams_send_channel_message', 'effectful-action'],
  ['imessage_send', 'effectful-action'],
  ['gmail_search', 'retrieval'],
  ['calendar_agenda_ms', 'retrieval'],
  ['outlook_read', 'retrieval'],
  ['onedrive_read', 'retrieval'],
  ['tracker_update_status', 'bookkeeping'],
  ['send_to_agent', 'bookkeeping'],
  ['show_to_user', 'delivery'],
];
const canaryErrors = [];
for (const [name, expected] of CANARY) {
  const got = classifyTool(name);
  if (got !== expected) canaryErrors.push(`classifyTool('${name}') === '${got}', expected '${expected}'`);
}

// ── (c) SEND_TO_PEOPLE covers every channel send (security surface) ──
const deny = new Set(sensei.SEND_TO_PEOPLE);
const sendTools = [...REGISTRY].filter((n) => channelOfSendTool(n) !== null);
const uncoveredSends = sendTools.filter((n) => !deny.has(n));
const sendErrors = [];
if (sendTools.length < 5) sendErrors.push(`only ${sendTools.length} channel sends found — channelOfSendTool import looks wrong.`);
if (uncoveredSends.length) sendErrors.push(`channel sends missing from SEND_TO_PEOPLE (Trainer/Healer under-block): ${uncoveredSends.join(', ')}`);

// ── (d) registry-EXHAUSTIVE accounting (anti-omission, 2026-07-08) ──
// Existence checks (a)-(c) stop typos/renames. These stop the mirror defect: a
// coverage-critical list MISSING a tool it should have. Same assertions as the
// server test tool-list-conformance.test.ts. Ledgers are Record<pattern,reason>
// with exact names or family-prefix globs (trailing '*').
const matchesLedger = (name, ledger) =>
  Object.keys(ledger || {}).some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : p === name));
const exhaustErrors = [];

const SEND_TO_PEOPLE_NA = sensei.SEND_TO_PEOPLE_NA;
const USER_TWINNED_SEND_PREFIXES = sensei.USER_TWINNED_SEND_PREFIXES;
const RECEIPT_EXEMPT = receipts.RECEIPT_EXEMPT;
if (!SEND_TO_PEOPLE_NA || !Array.isArray(USER_TWINNED_SEND_PREFIXES) || !RECEIPT_EXEMPT) {
  exhaustErrors.push('the built modules did not export the exhaustiveness ledgers (SEND_TO_PEOPLE_NA / USER_TWINNED_SEND_PREFIXES / RECEIPT_EXEMPT) — rebuild the server dist.');
} else {
  // SEND_TO_PEOPLE full-registry accounting.
  const unclassified = [...REGISTRY].filter((n) => !deny.has(n) && !matchesLedger(n, SEND_TO_PEOPLE_NA));
  if (unclassified.length) {
    exhaustErrors.push(
      `UNCLASSIFIED tool(s) — no comms decision: ${unclassified.join(', ')}. Add each to SEND_TO_PEOPLE ` +
      `(reaches a person on an owner channel: email/Teams/SMS/iMessage/voice) OR to the SEND_TO_PEOPLE_NA ` +
      `ledger with a reason, both in packages/server/src/agent/sensei-policy.ts.`,
    );
  }
  // user_ send-twin parity.
  const missingTwins = [...deny].filter(
    (n) => !n.startsWith('user_') && USER_TWINNED_SEND_PREFIXES.some((p) => n.startsWith(p)) && !deny.has(`user_${n}`),
  );
  if (missingTwins.length) {
    exhaustErrors.push(
      `user_ send twin(s) missing from SEND_TO_PEOPLE: ${missingTwins.map((n) => `user_${n}`).join(', ')}. ` +
      `The base send is denied but its owner-account twin is not (Trainer/Healer can send from the owner's ` +
      `personal account). Add each user_ twin to SEND_TO_PEOPLE in packages/server/src/agent/sensei-policy.ts.`,
    );
  }
  // RECEIPT accounting over the whole comms-send surface.
  const owingReceipt = sensei.SEND_TO_PEOPLE.filter(
    (n) => !(n in receipts.RECEIPT_TOOLS) && !matchesLedger(n, RECEIPT_EXEMPT),
  );
  if (owingReceipt.length) {
    exhaustErrors.push(
      `channel-send tool(s) with no receipt tier or exemption: ${owingReceipt.join(', ')}. Add a tier to ` +
      `RECEIPT_TOOLS (provider-id=1, refetch=2, exit-code=3) OR a reason to RECEIPT_EXEMPT, both in ` +
      `packages/server/src/receipts/store.ts.`,
    );
  }
  // Dead-ledger guards: exact ledger entries must resolve to real tools.
  const deadNa = Object.keys(SEND_TO_PEOPLE_NA).filter((p) => !p.endsWith('*') && !isRealTool(p));
  const deadExempt = Object.keys(RECEIPT_EXEMPT).filter((p) => !p.endsWith('*') && !isRealTool(p));
  if (deadNa.length) exhaustErrors.push(`SEND_TO_PEOPLE_NA exact entries that are not real tools: ${deadNa.join(', ')}`);
  if (deadExempt.length) exhaustErrors.push(`RECEIPT_EXEMPT exact entries that are not real tools: ${deadExempt.join(', ')}`);
}

const allErrors = [...listErrors, ...canaryErrors, ...sendErrors, ...exhaustErrors];
if (allErrors.length) {
  fail(`a tool-name list drifted from the real tool surface:\n    ` + allErrors.join('\n    '));
}

console.log(
  `  ✓ tool-list conformance gate: ${HAND_LISTS.length} hand lists reference real tools, ` +
  `${CANARY.length} derived classifications correct, ${sendTools.length} channel sends covered by SEND_TO_PEOPLE, ` +
  `${REGISTRY.size} registry tools all accounted for (SEND_TO_PEOPLE deny / NA ledger), ` +
  `receipt tiers + user_ send-twin parity exhaustive`,
);
process.exit(0);
