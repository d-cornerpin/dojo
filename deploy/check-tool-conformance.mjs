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
import fs from 'node:fs';
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

// ── (e) loop-signature content-field accounting (2026-07-21 incident class) ──
// The loop detector strips prose-named fields from call signatures. A tool whose
// operation identity IS its content field (document builders, content-bearing
// sends) then collapses distinct calls into one signature, and the 4th
// legitimate call gets STOP-blocked mid-work. Burned twice the same way:
// file_append (D5, 2026-07-08) and office_append_to_word_document (production
// incident 2026-07-21, a Word doc abandoned mid-build). This derivation scan
// makes the classification EXHAUSTIVE over the real tool surface: every
// registered tool carrying a free-text content-ish arg must either keep that
// field in its signature via a carve-out set, or be acknowledged with a reason.
const CONTENT_FIELD_ACK = {
  canvas_read: 'repeat-reads of the same canvas are the classic verification spiral; collapsing distinct prompts is intended',
  web_fetch: 'operation identity rides the url arg (non-prose); prompt collapse is harmless',
  web_browse: 'operation identity rides the url arg (non-prose); text collapse is harmless',
  history_expand: 'operation identity rides the message-id arg (non-prose); prompt collapse is harmless',
};
const PRESERVED_BY_SET = [
  [loop.SEARCH_TOOLS, new Set(['query'])],
  [loop.GENERATION_TOOLS, new Set(['description', 'prompt', 'text'])],
  [loop.COORDINATION_TOOLS, new Set(['payload', 'message'])],
  [loop.MUTATING_TOOLS, new Set(['content', 'text', 'message'])],
];
const CONTENT_FIELD_RE = /\b(content|text|message|payload|prompt)\s*:\s*\{[^}]{0,200}type:\s*['"](?:string|array)['"]/;
const contentErrors = [];
const contentHits = new Map();
{
  const distRoot = path.join(PKG_BASE, 'server/dist');
  const jsFiles = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) jsFiles.push(p);
    }
  })(distRoot);
  for (const f of jsFiles) {
    const text = fs.readFileSync(f, 'utf8');
    const nameRe = /name:\s*['"]([a-z0-9_]+)['"]/g;
    const marks = [];
    let mm;
    while ((mm = nameRe.exec(text))) marks.push({ name: mm[1], i: mm.index });
    for (let k = 0; k < marks.length; k++) {
      if (!REGISTRY.has(marks[k].name)) continue;
      const end = k + 1 < marks.length ? marks[k + 1].i : Math.min(text.length, marks[k].i + 9000);
      const slice = text.slice(marks[k].i, end);
      if (!slice.includes('input_schema')) continue;
      const cm = slice.match(CONTENT_FIELD_RE);
      if (cm && !contentHits.has(marks[k].name)) contentHits.set(marks[k].name, cm[1]);
    }
  }
}
if (contentHits.size < 10) {
  contentErrors.push(`content-field derivation scan found only ${contentHits.size} tool(s), the dist scan pattern looks broken.`);
}
for (const [name, field] of contentHits) {
  const preserved = PRESERVED_BY_SET.some(([set, fields]) => set && set.has(name) && fields.has(field));
  if (!preserved && !(name in CONTENT_FIELD_ACK)) {
    contentErrors.push(
      `'${name}' carries operation identity in free-text arg '${field}' but no carve-out set preserves it: ` +
      `distinct calls collapse to one loop signature and the 4th gets STOP-blocked mid-work (the abandoned-Word-doc class). ` +
      `Add it to the right set in packages/server/src/agent/v2/classifiers/loop.ts (usually MUTATING_TOOLS) ` +
      `or acknowledge it in CONTENT_FIELD_ACK here AND in tool-list-conformance.test.ts with a reason.`,
    );
  }
}
const deadAck = Object.keys(CONTENT_FIELD_ACK).filter((n) => !isRealTool(n));
if (deadAck.length) contentErrors.push(`CONTENT_FIELD_ACK entries that are not real tools: ${deadAck.join(', ')}`);

// ── (f) declared comms-to-people tier lock (lanes & lineage P7b) ──
// The comms-to-people decision is DECLARED at the tool definition site
// (`reachesPeople: true` on the ToolDefinition). sensei-policy.ts stays the
// runtime deny set (no-import leaf by design, cannot derive from the registry),
// so this section pins two-way equality between the declarations found in the
// built dist and SEND_TO_PEOPLE's base names: drift in either direction fails
// the release naming the tool. user_ twins inherit the flag via the
// twin-generation spread and are covered by the twin-parity check in (d).
// Standalone twin of the same assertion in tool-list-conformance.test.ts.
const tierErrors = [];
{
  const distRoot = path.join(PKG_BASE, 'server/dist');
  const jsFiles = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) jsFiles.push(p);
    }
  })(distRoot);
  const declared = new Set();
  for (const f of jsFiles) {
    const text = fs.readFileSync(f, 'utf8');
    const nameRe = /name:\s*['"]([a-z0-9_]+)['"]/g;
    const marks = [];
    let mm;
    while ((mm = nameRe.exec(text))) marks.push({ name: mm[1], i: mm.index });
    for (let k = 0; k < marks.length; k++) {
      if (!REGISTRY.has(marks[k].name)) continue;
      const end = k + 1 < marks.length ? marks[k + 1].i : Math.min(text.length, marks[k].i + 9000);
      const slice = text.slice(marks[k].i, end);
      if (!slice.includes('input_schema')) continue;
      if (/reachesPeople:\s*true/.test(slice)) declared.add(marks[k].name);
    }
  }
  const listBases = new Set([...deny].filter((n) => !n.startsWith('user_')));
  if (declared.size < 5) {
    tierErrors.push(`reachesPeople declaration scan found only ${declared.size} tool(s), the dist scan pattern looks broken.`);
  }
  const undeclared = [...listBases].filter((n) => !declared.has(n)).sort();
  const unlisted = [...declared].filter((n) => !listBases.has(n)).sort();
  if (undeclared.length) {
    tierErrors.push(
      `SEND_TO_PEOPLE base name(s) with no reachesPeople declaration on the tool definition: ${undeclared.join(', ')}. ` +
      `Add \`reachesPeople: true\` to each ToolDefinition so the decision lives at the definition site.`,
    );
  }
  if (unlisted.length) {
    tierErrors.push(
      `tool(s) declaring reachesPeople: true but missing from SEND_TO_PEOPLE: ${unlisted.join(', ')}. ` +
      `Add each to SEND_TO_PEOPLE in packages/server/src/agent/sensei-policy.ts (and its user_ twin if the family is twinned).`,
    );
  }
}

const allErrors = [...listErrors, ...canaryErrors, ...sendErrors, ...exhaustErrors, ...contentErrors, ...tierErrors];
if (allErrors.length) {
  fail(`a tool-name list drifted from the real tool surface:\n    ` + allErrors.join('\n    '));
}

console.log(
  `  ✓ tool-list conformance gate: ${HAND_LISTS.length} hand lists reference real tools, ` +
  `${CANARY.length} derived classifications correct, ${sendTools.length} channel sends covered by SEND_TO_PEOPLE, ` +
  `${REGISTRY.size} registry tools all accounted for (SEND_TO_PEOPLE deny / NA ledger), ` +
  `receipt tiers + user_ send-twin parity exhaustive, ` +
  `${contentHits.size} content-bearing tools all loop-signature-classified, ` +
  `reachesPeople declarations equal SEND_TO_PEOPLE bases`,
);
process.exit(0);
