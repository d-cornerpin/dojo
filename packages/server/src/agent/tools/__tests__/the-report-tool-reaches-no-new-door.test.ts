// ════════════════════════════════════════════════════════════════════════════════════════
// THE REPORT TOOL REACHES NO NEW DOOR (DOJO-REPORT T3, fix round 1 — finding I2).
//
// ── WHY THIS FILE EXISTS, STATED AS THE FAILURE IT REPLACES ──
// The shipped no-post guard was two clauses over `cat/report.ts`'s own TEXT: a five-name
// blacklist (`/github/`, `api.github.com`, `approveOnce`, `markPosted`, `postApprovedReport`)
// and a scan of that one file's own import specifiers. Review measured what that actually
// bought and the answer was nothing: the reviewer added a posting module under a name the
// blacklist does not know, imported it into `cat/report.ts`, CALLED it from the `submit` arm,
// and the tool performed a real outbound POST to the GitHub issues endpoint on every submit —
// with `the-report-tool-cannot-post.test.ts` at 10/10 green and the whole T3 set at 115/115.
//
// The module graph offers no isolation on its own. The transitive import closure from the
// handler is 528 modules; 37 of them call `fetch(`; `gateway/routes/update.ts` is ONE HOP away
// and holds four `fetch('https://api.github.com/repos/…')` calls; and `report/store.ts` — also
// one hop — EXPORTS the two one-shot approval doors. A blacklist of five spellings in front of
// that is name discipline wearing structure's clothes.
//
// ── WHAT A REAL GUARD HAS TO BE ──
// A census over the ACTUAL graph, in the ALLOWLIST direction, so the failure mode is "you
// added something and must say so" rather than "you avoided the five words we thought of".
// Three prongs, each answering a different question:
//
//   A. WHO MAY CONSUME AN APPROVAL? ANY edge to `report/store.ts` requires its importer to be
//      on a named list, UNLESS the edge is a braced static import binding only non-consent
//      names — the one spelling whose names are provable. Today that list is the store's own test.
//      **T7 adds exactly one more: the gateway route behind the owner's Post button.** That
//      is the point of this prong — when T7 lands, the diff that grants posting rights is a
//      one-line edit to a list called ALLOWED_CONSENT_CALLERS, in a file called this, and a
//      reviewer sees it. A poster that forgets to ask is a build failure.
//
//   B. DOES ANYTHING BEHIND THE TOOL CONSUME ONE? No module in the handler's import closure
//      may import those exports. Prong A says who is allowed; this says the tool is not
//      among them, and stays not among them however the graph is rewired.
//
//   C. HAS A NEW WAY OUT APPEARED BEHIND THE TOOL? The fetch-bearing modules in the closure
//      are pinned as a sorted manifest. A new outbound module reachable from the tool — the
//      exact shape of the reviewer's demonstration — is not in the manifest and fails here.
//      Plus the tightest clause of the three: the handler's and the gather's OWN one-hop
//      import lists are pinned exactly, so adding ANY import to either is a reviewed act.
//
// ── WHAT THIS FILE HONESTLY DOES NOT CLAIM ──
// It is a static import census, not a capability system. It cannot see a computed specifier,
// nor a door reached through a value passed in at runtime, and prong C cannot notice that an
// ALREADY-reachable fetch-bearing module gained a new call site — which is why prong C is
// paired with the exact one-hop pins rather than trusted alone. What it guarantees is that
// the graph behind this tool cannot change SHAPE without a human editing one of the four
// lists below.
//
// ⚠ AND ONE MORE THING IT DID NOT CLAIM UNTIL T7's FIX ROUND, BECAUSE NOBODY HAD ASKED: that
// the SUBJECT list is complete. Every prong here is a statement about `CONSENT_EXPORTS`, and
// that constant was maintained by REMEMBERING to add to it. `releaseApproval` shipped outside
// it and the reviewer's alias probe rode both prongs green — the blind spot arrived in the same
// commit as the door it failed to see, which is the worst possible timing and the most likely.
// Membership is now DERIVED from `report/store.ts`'s own source (see the classification clause
// under prong A) and declared either way, so the completeness this file's three prongs rest on
// is itself a failing clause rather than an author's memory.
//
// What it no longer does is ENUMERATE. Three rounds of review beat three enumerations — five
// forbidden names, then one import spelling out of six, then two readers pinned against
// different vocabularies so a dynamic `await import(…)` bound a door at 26/26 green. An
// enumerator must be exhaustive; an evader only has to be surprising. So prong A now asks for
// a PROOF OF INNOCENCE instead of evidence of guilt, and the fixture tables below pin the
// rule's vocabulary in both directions — the nine specifier forms the walk sees, and the one
// form out of nine that can prove which names it binds.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..', '..', '..');
const HANDLER = path.join(SRC, 'agent', 'tools', 'cat', 'report.ts');
const STORE_REL = 'report/store.ts';

/**
 * The doors that MOVE an owner's one approval. Named here so the census has a subject.
 *
 * ── `releaseApproval` IS ON THIS LIST, AND THE LIST'S NAME IS WHAT MISLED ITS AUTHOR (T7 F1) ──
 * It is a BACKWARDS door: it hands a decision back rather than spending it, so "the doors that
 * CONSUME an approval" — this constant's old sentence — read as an argument for leaving it off,
 * and it shipped off. The census's question is not "who may spend it" but **WHO MAY MOVE IT**,
 * and the consequence of the narrower reading was measured by review rather than imagined:
 * `const undo = releaseApproval; undo(id)` in `report/collect.ts` — runtime-reachable from the
 * tool, on no allowlist — rode BOTH prongs green at 58/58, while the identical alias on
 * `approveOnce` went RED 2 F / 56 P. One word of difference.
 *
 * The class it closes is a D4 violation: the route's `await postApprovedReport(...)` is a real
 * yield point with the row sitting in `approved`, and anything that flips it back there while
 * the issue lands gives one approval two issues.
 *
 * ⚠ THE LIST IS NO LONGER MAINTAINED BY REMEMBERING. The clause "every status-moving door in
 * the store is classified" below reads `report/store.ts` and requires EVERY exported transition
 * to be named either here or in `NON_CONSENT_TRANSITIONS` — so the next door added to that file
 * cannot be silently absent from the guard that exists to police it, which is exactly how this
 * one was.
 */
const CONSENT_EXPORTS = ['approveOnce', 'markPosted', 'markExported', 'releaseApproval'];

/**
 * The store's other status-moving exports, and why each is NOT a consent door. Declared rather
 * than left absent: an absence is what F1 was.
 *
 *   `submitForApproval`  drafting → awaiting_approval. It ASKS for a decision; it makes none,
 *                        and a row it moves has never held an approval.
 *   `cancelReport`       → cancelled, legal from `approved` too. It is the SAFE DIRECTION: it
 *                        destroys an approval rather than moving it toward delivery, and
 *                        nothing is published by it. A second caller of this one could discard
 *                        someone's pending report, which is a denial, not a publication — a
 *                        real hazard, and a different guard's (the call-site census in
 *                        `gateway/routes/__tests__/only-the-card-can-post-a-report.test.ts`
 *                        covers the call side). BOUNDARY DECIDED, NOT FORGOTTEN: if this file
 *                        ever has to answer "who may make a report disappear", this is the name
 *                        to move.
 */
const NON_CONSENT_TRANSITIONS = ['submitForApproval', 'cancelReport'];

/**
 * PRONG A's LIST. Every file in `packages/server/src` that imports a consent export.
 * An addition here is a grant of posting rights and must be read as one.
 */
const ALLOWED_CONSENT_CALLERS: readonly string[] = [
  // The store's own lifecycle test — it drives the doors to prove they are one-shot.
  'report/__tests__/a-report-is-approved-once-and-only-once.test.ts',
  // ── APPENDED BY DOJO-REPORT T6, AND THIS IS THE ONE-LINE EDIT THE HEADER PROMISED ──
  // The gateway route behind the owner's Post button. (The header above says T7; the route
  // landed in T6, which is where the card and its doors are built. The grant is the same one.)
  //
  // THE EDGE IS THE BRACED STATIC FORM, which is the only spelling whose bound names are
  // statically provable, and it binds two consent doors by name:
  //
  //   import {
  //     approveOnce, cancelReport, editBrief, getReport, listOpenReports, markExported,
  //     type ReportStatus,
  //   } from '../../report/store.js';
  //
  // `approveOnce` mints the owner's decision and `markExported` spends it — the export door is
  // bound by D4 exactly as the poster is (contract C3), so one approval is one delivery
  // whichever way the report leaves. `editBrief` is the owner's own edit door and consumes
  // nothing. Nothing else in the file reaches the store, and there is no dynamic import.
  //
  // WHY THIS FILE AND NOT ANOTHER: `POST /api/reports/:id/approve` is the ONLY call site of
  // `approveOnce` in the tree — held from the other direction by the source census in
  // `gateway/routes/__tests__/only-the-card-can-post-a-report.test.ts`, which asserts the
  // call-site set equals exactly `['gateway/routes/reports.ts']`. Prong A here answers "who may
  // BIND a door"; that clause answers "who may CALL one". Neither is sufficient alone.
  //
  // ⚠ T7 ADDS A SECOND ENTRY. Its poster calls `markPosted`, so it must be named here AND on
  // FETCH_BEARING_IN_CLOSURE — see the note at the head of that list, which is written for it.
  'gateway/routes/reports.ts',
  // ── APPENDED BY DOJO-REPORT T7. THIS IS THE ONE-LINE EDIT, AND IT IS THE REVIEW ──
  // THE EDGE IS THE BRACED STATIC FORM, and it binds one consent door by name:
  //
  //   import { getReport, markPosted, type ReportRow } from './store.js';
  //
  // `markPosted` is the SECOND HALF of the one-shot. `approveOnce` (the route, above) mints the
  // owner's decision; this module spends it, and only ever after GitHub has ACCEPTED the report
  // — the row is not touched on any failure path, which is why a poster that is called twice
  // cannot deliver twice. The `WHERE status = 'approved'` in `markPosted` is what makes that
  // structural rather than conventional.
  //
  // WHY THIS MODULE AND NOT ANOTHER: it is the only thing in the tree that can turn an approved
  // report into an issue. The complementary claim — that it is the only module that CALLS
  // `markPosted` — is held from the other direction by the call-site census in
  // `gateway/routes/__tests__/only-the-card-can-post-a-report.test.ts`, which T7 widened from
  // `approveOnce` alone to all four doors (mint, both spends, and the release).
  //
  // ⚠ IT IS ALSO ON FETCH_BEARING_IN_CLOSURE'S SIBLING BELOW (`github/issues.ts`, which holds
  // the actual outbound calls). Both lists, as that note demanded.
  'report/post.ts',
  // The poster's own suite, which drives the doors to prove nothing posts without an approval —
  // the same reason the store's lifecycle test is the first entry on this list.
  'github/__tests__/a-matching-issue-gets-a-comment-not-a-duplicate.test.ts',
];

/** PRONG C's exact one-hop pins. Adding an import to either file fails this file. */
const HANDLER_IMPORTS: readonly string[] = [
  '../../../gateway/routes/update.js', '../../../gateway/ws.js', '../../../report/bundle.js',
  '../../../report/gather.js', '../../../report/signature.js', '../../../report/store.js',
  '../../../report/telemetry-build.js', '../../../report/window.js', '../handler.js',
];
const GATHER_IMPORTS: readonly string[] = [
  '../credentials/secret-values.js', '../gateway/routes/update.js', '../logger.js',
  '../memory/message-store.js', './arg-shape.js', './collect.js', './signature.js',
  './telemetry-build.js', './window.js',
];

/**
 * PRONG C's MANIFEST — every module in the handler's closure that calls `fetch(`.
 *
 * This is a RECORD OF WHAT IS, not a permission list: the engine's graph is broad and most of
 * these are reachable only because the tool registry pulls in the whole toolbox. The guard is
 * the DELTA. A name appearing here that was not here before means a new outbound door became
 * reachable from a tool whose entire purpose is that it cannot send — read the diff and say
 * why before editing this list.
 */
const FETCH_BEARING_IN_CLOSURE: readonly string[] = [
  // ── APPENDED BY DOJO-REPORT T4, and this comment IS the review the clause demanded ──
  // `github/device-flow.ts` calls `fetch` three times and is now in the closure. It was read
  // before it was added, and here is what the reading found.
  //
  // THE PATH, measured rather than guessed — four hops, and the tool is not on any of them:
  //   cat/report.ts → gateway/routes/update.ts → gateway/server.ts → gateway/routes/github.ts
  //   → github/device-flow.ts
  //
  // ⚠ AND HOP 2 IS NOT A RUNTIME EDGE AT ALL, WHICH IS THE FACT THAT SETTLES IT.
  // `gateway/routes/update.ts:11` reads `import type { AppEnv } from '../server.js'` — a
  // TYPE-ONLY import, ERASED AT COMPILE TIME. Nothing is required, nothing is evaluated, and
  // the emitted `.js` has no such edge. Re-running this file's own walk with type-only edges
  // dropped, the closure falls from 532 modules to 464 and `gateway/server.ts`,
  // `gateway/routes/github.ts` and ALL FOUR `github/*` modules are NOT REACHABLE FROM THE TOOL
  // AT RUNTIME. The same is true of the whole router fan-out that put `gateway/routes/config.ts`,
  // `setup-deps.ts`, `system.ts`, `techniques.ts` and `upload.ts` on this list: it is a phantom
  // of the static walk.
  //
  // That is NOT a hole, and the direction matters: the walk over-approximates, so it considers
  // MORE modules reachable than really are, never fewer. Keeping the over-approximation is
  // correct — a type-only edge can become a runtime edge in a one-word edit, and this census
  // should notice that before it happens, not after. But the safety case is stronger than
  // "everything fans out from the server", and the strongest true statement belongs here.
  //
  // WHY IT IS NOT A WAY OUT, in the three terms this file is written in:
  //   * The handler's and the gather's OWN one-hop import lists are pinned EXACTLY below and
  //     are UNCHANGED by T4 — nothing in `report/` names anything in `github/`.
  //   * Prong B is green: no module in the closure imports a consent door, and T4 added none.
  //   * The two endpoints it posts to are GitHub's OAUTH endpoints (`/login/device/code`,
  //     `/login/oauth/access_token`) plus `GET /user`. None of them accepts content; there is
  //     no body a brief could ride out on, and no function here takes a report, a brief or an
  //     agent id as an argument. Compare `gateway/routes/update.ts`, already on this list,
  //     which really does hold four `api.github.com/repos/…` calls.
  //   * Its four entry points are reachable only from `POST /api/github/*`, behind the owner's
  //     own authenticated session, never from a tool call.
  //
  // ⚠ FOR T7, AND THIS IS THE REUSABLE FORM OF THE ARGUMENT ABOVE. Do not reason from fan-out
  // breadth — "lots of things are reachable from the server" proves nothing about anybody. The
  // two questions that actually separate a phantom edge from a way out are:
  //
  //   1. IS IT RUNTIME-REACHABLE from the handler, with type-only edges dropped? (This module:
  //      NO. A poster imported by `gateway/routes/reports.ts` behind the Post button: also
  //      almost certainly no — but MEASURE it, do not assume it.)
  //   2. DOES ANY EXPORTED FUNCTION ACCEPT CALLER-SUPPLIED CONTENT THAT REACHES THE WIRE?
  //      (This module: NO — see the entry-point audit above. A poster: YES, unavoidably, because
  //      its whole job is to carry a rendered brief to `POST /repos/:owner/:repo/issues`.)
  //
  // Question 2 is the one that decides it, and the poster fails it by construction. So the
  // poster's appearance here is the moment to check prong A as well: it must ALSO be on
  // ALLOWED_CONSENT_CALLERS, because posting is what consumes the owner's one approval.
  'github/device-flow.ts',
  // ── APPENDED BY DOJO-REPORT T7, AND THIS ENTRY DOES NOT BORROW THE ONE ABOVE ──
  // `github/issues.ts` holds the three calls that reach GitHub's issues: one unauthenticated
  // search and two authenticated writes. The T4 entry above answers the two questions this list
  // asks and gets NO for both. This module answers NO and **YES**, and the difference is the
  // whole reason it is written out rather than waved at the neighbour's paragraph.
  //
  //   1. RUNTIME-REACHABLE FROM THE TOOL? NO — measured, not assumed. The path in the
  //      over-approximating walk is cat/report.ts → gateway/routes/update.ts → gateway/server.ts
  //      → gateway/routes/reports.ts → report/post.ts → github/issues.ts, and hop 2 is
  //      `import type { AppEnv }`, ERASED AT COMPILE TIME. Re-running this file's own walk with
  //      type-only edges dropped: 538 modules over-approximating, 464 at runtime, and
  //      `report/post.ts`, `github/issues.ts`, `report/issue-body.ts` and `report/repo.ts` are
  //      ALL ABSENT from the runtime set. The clause "the gateway is NOT runtime-reachable from
  //      the tool" pins the fact this rests on, and prong B measures on the runtime closure.
  //
  //   2. DOES AN EXPORTED FUNCTION CARRY CALLER-SUPPLIED CONTENT TO THE WIRE? **YES.**
  //      `createIssue(repo, title, body, labels)` exists to carry a rendered brief to
  //      `POST /repos/:owner/:repo/issues`. T4's argument — "none of these endpoints accepts
  //      content" — IS NOT AVAILABLE HERE and must not be reused. What makes it safe is a
  //      different fact, and it is a fact about the CALLER rather than the callee:
  //
  //        * its only caller is `report/post.ts`, which is on ALLOWED_CONSENT_CALLERS above and
  //          refuses every row that is not already `approved` — measured as ZERO network calls,
  //          not as a returned error;
  //        * the only thing that can produce an `approved` row is `approveOnce`, called from
  //          exactly one place in the tree: the route behind the owner's Post button (D4);
  //        * the body it carries is `renderIssueBody(row)` — the platform's own renderer over a
  //          row the owner has READ, never a string a caller hands in.
  //
  //      So the content door is real and the gate in front of it is the owner's consent, which
  //      is the only gate that was ever going to be adequate for a module whose job is to
  //      publish. A future edit that lets some other module call `createIssue` fails prong A at
  //      `report/post.ts`'s call-site census before it fails anything here.
  'github/issues.ts',
  'agent/model.ts', 'agent/runtime.ts', 'agent/site-snapshot.ts', 'agent/tools/definitions.ts',
  'agent/tools/types.ts', 'agent/web-tools.ts', 'gateway/routes/config.ts',
  'gateway/routes/setup-deps.ts', 'gateway/routes/system.ts', 'gateway/routes/techniques.ts',
  'gateway/routes/update.ts', 'gateway/routes/upload.ts', 'google/auth.ts', 'google/client.ts',
  'google/tools-slides.ts', 'memory/embeddings.ts', 'microsoft/auth.ts', 'microsoft/client.ts',
  'microsoft/tools-office.ts', 'microsoft/tools-read.ts', 'microsoft/tools-write.ts',
  'receipts/store.ts', 'services/audio-generation.ts', 'services/capabilities.ts',
  'services/image-generation.ts', 'services/litellm-pricing-sync.ts',
  'services/num-ctx-calculator.ts', 'services/ollama.ts', 'services/transcription.ts',
  'services/video-generation.ts', 'tools/unified-read.ts', 'twilio/client.ts',
  'twilio/sms-inbound.ts', 'update/artifact-integrity.ts', 'voice/model-manager.ts',
  'voice/smart-turn.ts', 'voice/stt-service.ts',
];

// ── the walk ────────────────────────────────────────────────────────────────────────────
// Comment lines are dropped before a specifier is read. Four `await import('…')` mentions in
// the toolbox's header prose would otherwise be counted as real edges and reported as holes,
// and a walk that reports holes it invented teaches readers to ignore its holes.
//
// ── N2 (fix round 2): THE BARE IMPORT ──
// The first cut read `from '…'`, `import('…')` and `require('…')`. A side-effect import —
// `import './x.js';` — has no `from` and no parenthesis, so it was invisible, and one exists
// in the tree today: the real closure is 528 modules, not the 526 this file measured. Neither
// missed module calls `fetch`, so prong C was complete BY LUCK, NOT BY LAW. The `\bimport\s*`
// alternation is the whole fix, and the clause below pins every spelling the repo uses.

// ── INV-1 (T3's closing hand-off, closed by T7): THE BACKTICK SPECIFIER ──
// The reader saw `'…'` and `"…"` and nothing else, so `await import(\`./x.js\`)` and
// `require(\`./x.js\`)` — both legal, both non-interpolated, both ordinary — were invisible at
// EVERY hop. Under the inverted rule a dynamic edge is consent-binding BY DEFAULT, so a
// backtick dynamic import of the store would have walked past prong A entirely. Measured at
// this HEAD: ZERO occurrences in `packages/server/src`, which is exactly the condition T3 named
// as "complete by luck, not by law" — it stops being true without warning.
//
// The fix is one delimiter alternation with a BACKREFERENCE, so the closing delimiter must
// match the opening one and `'x\`` is not a specifier. The two type-aware readers below
// (`TYPE_ONLY`, `BRACED_STATIC`) are deliberately NOT widened: a backtick is illegal in a
// static `import … from` clause, and every direction the asymmetry can be wrong in is the safe
// one — an edge this reader sees and they do not is an edge that keeps its runtime status and
// cannot prove its names, which is precisely how an unproven edge is supposed to behave.
//
// ⚠ AND THE WIDENING IMMEDIATELY FOUND A LATENT OVER-READ, WHICH IS WHY `\n` IS EXCLUDED TOO.
// `cat/report.ts:131` ends a template with "a lane from `" and line 132 opens the next one with
// "+ `" — so "from ` … `" is a perfectly good backtick-delimited string, and the reader called
// the prose between them a module specifier. The exact pins caught it on the first run rather
// than a reviewer catching it later. A module specifier NEVER contains a newline, so excluding
// one costs nothing real and closes the class for every delimiter, single quotes included.
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s*)(['"`])([^'"`\n]+)\1/g;
const isComment = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line);

const stripComments = (code: string): string =>
  code.split('\n').filter(l => !isComment(l)).join('\n');

/** Every module specifier in a piece of code, in any spelling that creates an EDGE. */
function specifiersIn(code: string): string[] {
  return [...stripComments(code).matchAll(SPEC)].map(m => m[2]);
}

function specifiersOf(file: string): string[] {
  return specifiersIn(fs.readFileSync(file, 'utf8'));
}

// ── T6 / N4: A TYPE-ONLY EDGE IS NOT AN EDGE AT RUNTIME, AND PRONG B HAD TO LEARN IT ────────
//
// The FETCH_BEARING_IN_CLOSURE note above already measured this and wrote the argument down for
// whoever landed the gateway route: `gateway/routes/update.ts:11` reads
// `import type { AppEnv } from '../server.js'`, TypeScript ERASES it, and the emitted `.js` has
// no such edge — so `gateway/server.ts` and everything it fans out to are phantoms of the static
// walk, not modules the tool can reach.
//
// T6 is when that stops being a note. `gateway/routes/reports.ts` legitimately binds two consent
// doors, `gateway/server.ts` legitimately mounts it, and the over-approximating walk therefore
// puts the owner's Post button inside "the tool's closure". Prong B asserts that set is EMPTY, so
// on the phantom edge alone it would fail for a route that is not reachable from any tool call —
// a guard that fires on a fact it cannot be satisfied about teaches people to edit the guard.
//
// So prong B — and ONLY prong B — is measured on the RUNTIME closure, with type-only edges
// dropped. Prong C keeps the over-approximation deliberately: a type-only edge becomes a runtime
// edge in a one-word deletion, and the fetch manifest should notice that while it is still cheap.
// The two closures are asserted against each other below, and the fact the whole argument rests
// on — that `gateway/server.ts` is NOT runtime-reachable from the handler — is pinned rather than
// assumed, so the day somebody adds a real edge, this file says so before prong B does.
//
// MEASURED AT THIS HEAD: 532 modules over-approximating, 464 at runtime.
const TYPE_ONLY =
  /(?:\bimport|\bexport)\s+type\s+(?:\{[^}]*\}|[A-Za-z_$][\w$]*|\*\s+as\s+[A-Za-z_$][\w$]*)\s*from\s*['"]([^'"]+)['"]/g;

/**
 * Specifiers that survive erasure. One credit per type-only edge, spent against one occurrence
 * of the same specifier — so a file holding BOTH `import type { T } from './x.js'` and
 * `import { v } from './x.js'` keeps the runtime edge, which is the safe direction.
 *
 * ── THE INVARIANT THAT MAKES THIS SOUND, AND IT IS STRUCTURAL RATHER THAN A HAPPY FIXTURE ──
 * The dangerous direction is the FALSE NEGATIVE: a real value edge mistaken for an erased one
 * would vanish from prong B's set silently. The fixture table below drives that direction, but
 * fixtures only cover what somebody thought of, and `stripComments` drops only lines that START
 * with a comment marker — so a TRAILING `// import type { T } from './x.js'` beside a real value
 * import looks like it should steal that import's credit. It cannot, and here is why:
 *
 *   EVERY `TYPE_ONLY` MATCH NECESSARILY CONTAINS `from '…'`, WHICH `SPEC` ALSO MATCHES.
 *
 * So any text that produces a spurious CREDIT produces a spurious OCCURRENCE in the same breath,
 * and the two cancel. Credits can therefore never exceed occurrences for a given specifier, and
 * a plain value import always contributes an occurrence WITHOUT a credit. Together those two
 * facts mean A REAL EDGE CAN NEVER BE FULLY CONSUMED — not by a trailing comment, not by a block
 * comment on the same line, not by a type import inside a string literal, and not by any future
 * text this file has not imagined. The property holds by construction, not by enumeration, which
 * is the direction this whole file was rewritten in three times.
 * (Recorded at the reviewer's request, fix round 1: it is stronger than the table alone conveys.)
 *
 * ⚠ WHAT IT CANNOT SEE, and the direction the blindness runs: an `import { type T } from '…'`
 * with ONLY inline type members is erased by TypeScript and is NOT matched here, so it counts as
 * a runtime edge. That is an over-read, and an over-read fails SAFE — it can only put more
 * modules in prong B's set, never fewer.
 */
function runtimeSpecifiersIn(code: string): string[] {
  const clean = stripComments(code);
  const credits = new Map<string, number>();
  for (const m of clean.matchAll(TYPE_ONLY)) credits.set(m[1], (credits.get(m[1]) ?? 0) + 1);
  const kept: string[] = [];
  for (const spec of specifiersIn(clean)) {
    const left = credits.get(spec) ?? 0;
    if (left > 0) { credits.set(spec, left - 1); continue; }
    kept.push(spec);
  }
  return kept;
}

/** The one form whose bound names are STATICALLY PROVABLE. Everything else is an assumption. */
const BRACED_STATIC = /(?:import|export)\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;

const bindsAConsentName = (clause: string): boolean =>
  clause.split(',')
    .map(s => s.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, '').trim())
    .some(n => CONSENT_EXPORTS.includes(n));

/**
 * ── N3 (fix round 3): THE RULE IS INVERTED. STOP ENUMERATING SPELLINGS. ──
 *
 * Rounds 1 and 2 both enumerated the ways a door could be bound, and both were beaten by a
 * way nobody had listed — five names, then one spelling out of six, then the two readers
 * pinned against DIFFERENT vocabularies: the walk saw `await import('…')` edges, the consent
 * reader saw only static `from`-bearing forms, so
 *
 *   const { approveOnce } = await import('../../report/store.js');
 *
 * bound a consent door at 26/26 green. That is not an exotic spelling — the tree holds 502
 * relative `await import(…)` calls, 479 of them destructuring, 91 inside `gateway/routes`,
 * which is exactly where T7's posting route lands. Nothing binds dynamically today (measured
 * zero), so the promise held by luck while failing under the codebase's dominant idiom.
 *
 * Enumeration loses because the enumerator has to be exhaustive and the evader only has to be
 * surprising. So the question this function asks is inverted:
 *
 *   NOT "does this edge bind a consent name?"  (unbounded, needs a complete list of spellings)
 *   BUT "does this edge PROVE it binds no consent name?"  (bounded, one spelling can do it)
 *
 * ANY edge to the store — in any of the nine spellings `SPEC` provably sees — requires its
 * importer to be on `ALLOWED_CONSENT_CALLERS`, UNLESS the edge is the braced static form and
 * its name list contains no consent name. Dynamic, namespace, re-export, bare and default
 * edges are consent-binding BY DEFAULT: the same direction as round 2's star ruling, now
 * applied uniformly instead of case by case. A new import syntax invented tomorrow lands on
 * the safe side without this file being touched.
 *
 * ⚠ THE TRADE, STATED SO NOBODY FILES IT AS A BUG. A file that dynamically imports the store
 * and destructures ONLY `getReport` is FLAGGED, and that is correct rather than tolerated:
 * destructured names from an `await import(…)` are not statically provable (`const { [k]: f }`
 * is legal, and so is reaching the namespace object afterwards). Such a file has two honest
 * remedies — convert the edge to the braced static form, which is the spelling that carries
 * its own proof, or be added to the allowlist and reviewed. Both are cheap; neither is silent.
 * The house rule is unchanged and now load-bearing: IF YOU WANT THE REPORT STORE, NAME WHAT
 * YOU WANT, STATICALLY.
 *
 * Returns the specifier of every edge that does NOT carry that proof. The caller resolves
 * them, so an unproven edge to some other module is simply not the store's business.
 */
function unprovenEdgesIn(code: string): string[] {
  const clean = stripComments(code);
  // One proof token per provably-innocent braced edge, keyed by specifier.
  const proofs = new Map<string, number>();
  for (const m of clean.matchAll(BRACED_STATIC)) {
    if (bindsAConsentName(m[1])) continue;
    proofs.set(m[2], (proofs.get(m[2]) ?? 0) + 1);
  }
  const unproven: string[] = [];
  for (const spec of specifiersIn(clean)) {
    const left = proofs.get(spec) ?? 0;
    // A file may hold BOTH an innocent braced edge and a dynamic one to the same module.
    // Each proof covers exactly one edge; the surplus edge stays unproven, as it should.
    if (left > 0) { proofs.set(spec, left - 1); continue; }
    unproven.push(spec);
  }
  return unproven;
}

// ── THE CLASSIFICATION READER (T7 fix round 2, G1) ────────────────────────────────────────
//
// Fix round 1 derived `CONSENT_EXPORTS`'s completeness from the store's own source, so the list
// can no longer be short by accident. Round 2's finding is the layer under that: THE READER THAT
// DERIVES IT NEEDED THE SAME FIXTURES EVERY OTHER READER IN THIS FILE HAS. Written as
// `/export function (\w+)/` + `/SET\s+status\s*=/`, it was blind to two door shapes that really
// do move an approval, both planted by review at 61/61 green:
//
//   (a) `SET updated_at = datetime('now'), status = 'awaiting_approval'`  — status not FIRST
//   (b) `export const unpostB = (id) => transition(…)`                     — an arrow-const export
//
// ⚠ AND THE NAIVE WIDENING IS WRONG, which is why this is a scan rather than a looser regex.
// "Look for `status` anywhere after SET" goes RED on `attachDraft`, whose status sits in its
// WHERE and not its SET — it reads the state, it does not move it. The write list is the text
// between `SET` and whatever ENDS it, so the scan bounds at `WHERE` (or the end of the SQL
// literal, or the statement's semicolon) and looks only inside that.
//
// The fixture table below was written BEFORE this reader and is what shaped it: both reviewer
// doors, the comma list, the arrow-const, `async`, a one-hop delegation — and, in the other
// direction, `attachDraft`'s real text, a SELECT, a private writer and a status in a string.
// That is the discipline this file has learned three times and had not applied to its newest
// reader: WHEN YOU BUILD A CENSUS, THE READER IS THE PART THAT NEEDS THE FIXTURES.

/** Top-level declarations in source order — exported or not, `function`, `const`, `class`. */
const TOP_LEVEL = /^(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)/gm;

/**
 * The columns a statement WRITES: from `SET` to whatever ends the assignment list. Bounding at
 * `WHERE` is the whole point — a predicate that READS `status` is not a door that moves it.
 *
 * ⚠ THE STOP SET EXCLUDES `'`, AND THE FIXTURE TABLE IS WHY. The first cut stopped at any quote,
 * which is wrong twice over: `SET updated_at = datetime('now'), status = 'x'` cuts at the quote
 * inside `datetime('now')` — BEFORE the column it exists to find — and both of review's planted
 * doors carry exactly that. SQL literals are single-quoted INSIDE a backtick template, so only a
 * backtick or a statement's semicolon can end one. Two of the six CAUGHT rows went red on the
 * first run of this reader and that is the table doing its job.
 */
function setClausesIn(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/\bSET\b/gi)) {
    const rest = code.slice((m.index ?? 0) + m[0].length);
    const stop = rest.search(/\bWHERE\b|[`;]/i);
    out.push(stop === -1 ? rest : rest.slice(0, stop));
  }
  return out;
}

const writesStatus = (body: string): boolean =>
  setClausesIn(body).some(clause => /\bstatus\s*=/i.test(clause));

/**
 * Every EXPORTED binding in a module whose body moves `status`, directly or through ONE hop into
 * a private writer in the same file. The one hop is not decoration: an exported wrapper over a
 * module-private `UPDATE … SET status` moves the approval exactly as surely as the write does,
 * and is the shape anybody avoiding this census would reach for first.
 */
function statusWriters(source: string): string[] {
  const src = stripComments(source);
  const decls = [...src.matchAll(TOP_LEVEL)]
    .map(m => ({ name: m[1], at: m.index ?? 0, exported: m[0].startsWith('export') }));
  const bodyOf = (i: number): string =>
    src.slice(decls[i].at, i + 1 < decls.length ? decls[i + 1].at : src.length);

  const direct = new Set(decls.filter((_, i) => writesStatus(bodyOf(i))).map(d => d.name));
  const privateWriters = decls.filter(d => !d.exported && direct.has(d.name)).map(d => d.name);

  const doors = decls.filter((d, i) => d.exported && (
    direct.has(d.name) || privateWriters.some(p => new RegExp(`\\b${p}\\s*\\(`).test(bodyOf(i)))
  ));
  return [...new Set(doors.map(d => d.name))].sort();
}

function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;   // a package, not a module of ours
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [
    base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'),
    `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function closureFrom(entry: string, runtimeOnly = false): { modules: string[]; unresolved: string[] } {
  const seen = new Set<string>();
  const unresolved: string[] = [];
  const stack = [path.resolve(entry)];
  const read = (f: string): string[] => (runtimeOnly
    ? runtimeSpecifiersIn(fs.readFileSync(f, 'utf8'))
    : specifiersOf(f));
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of read(file)) {
      const resolved = resolveSpec(file, spec);
      if (resolved) stack.push(resolved);
      else if (spec.startsWith('.')) unresolved.push(`${path.relative(SRC, file)} -> ${spec}`);
    }
  }
  return { modules: [...seen].map(f => path.relative(SRC, f)).sort(), unresolved: [...new Set(unresolved)] };
}

function allSourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) allSourceFiles(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Files holding an edge to the report store that does not prove it binds no consent door. */
function consentImporters(): string[] {
  const hits: string[] = [];
  for (const file of allSourceFiles(SRC)) {
    for (const spec of unprovenEdgesIn(fs.readFileSync(file, 'utf8'))) {
      const target = resolveSpec(file, spec);
      if (target && path.relative(SRC, target) === STORE_REL) {
        hits.push(path.relative(SRC, file));
        break;
      }
    }
  }
  return [...new Set(hits)].sort();
}

const CLOSURE = closureFrom(HANDLER);
/** The same walk with erased edges dropped — what the tool can reach when the process runs. */
const RUNTIME = closureFrom(HANDLER, true);

// ⚠ THE READERS ARE TESTED BEFORE ANYTHING THEY READ IS TRUSTED (fix round 2, N1 + N2).
// Everything below this file's two regexes rests on them seeing what is actually written in
// the repo. Round 1 shipped a census that read ONE import spelling out of six and reported
// green while a module held the approval doors — the same defect as the five-name blacklist
// this file replaced, moved one layer up. So the spellings are pinned as fixtures, here,
// where a missing form is a failing clause rather than a silent hole in a 528-module walk.

describe('the specifier reader sees every import spelling that creates an edge', () => {
  const FORMS: readonly [string, string][] = [
    ['named', `import { a } from './x.js';`],
    ['default', `import d from './x.js';`],
    ['namespace', `import * as n from './x.js';`],
    // N2: no `from`, no parenthesis — invisible to the round-1 reader, and one exists today.
    ['bare side-effect', `import './x.js';`],
    ['dynamic', `const m = await import('./x.js');`],
    ['require', `const m = require('./x.js');`],
    // INV-1, T7: the two forms a backtick is legal in. Zero occurrences in the tree today,
    // which is why this row exists — the reader must see a spelling before somebody writes it,
    // not after. (A backtick cannot appear in a static `import … from` clause at all.)
    ['dynamic with backticks', 'const m = await import(`./x.js`);'],
    ['require with backticks', 'const m = require(`./x.js`);'],
    ['re-export named', `export { a } from './x.js';`],
    ['re-export star', `export * from './x.js';`],
    ['re-export star as', `export * as n from './x.js';`],
  ];

  for (const [label, code] of FORMS) {
    it(`sees a ${label} import`, () => {
      expect(specifiersIn(code), `the walk is blind to the ${label} form: ${code}`).toEqual(['./x.js']);
    });
  }

  it('still ignores a specifier that only appears in prose', () => {
    expect(specifiersIn(`// the old \`await import('../agent/tools.js')\` hack\nconst x = 1;`)).toEqual([]);
  });

  it('will not read the prose BETWEEN two strings as a specifier', () => {
    // The real shape, from `cat/report.ts`: a template ending in "… a lane from `" followed by
    // a continuation line opening with "+ `". A specifier has no newline in it.
    const code = 'const s = `a lane from `\n        + `[${LANES.join()}], and the rest`;';
    expect(specifiersIn(code), 'the reader invented an edge out of prose').toEqual([]);
  });

  it('will not pair a quote with a backtick to invent a specifier', () => {
    // The backreference is what makes the widening safe: without it, `'…\`` and `\`…'` become
    // specifiers, and a walk that invents edges reports holes nobody can close.
    expect(specifiersIn('const m = await import(\'./x.js`);')).toEqual([]);
  });

  it('sees a backtick edge to the store as UNPROVEN, like every other dynamic one', () => {
    // The pair the widening exists for: the reader must see the edge (above), and the rule must
    // then refuse it (here). Either half alone is a hole.
    expect(unprovenEdgesIn('const { approveOnce } = await import(`./store.js`);'))
      .toContain('./store.js');
  });
});

// ── THE ERASURE READER'S OWN VOCABULARY (T6 / N4) ───────────────────────────────────────
// Prong B now rests on this function, so it is pinned in BOTH directions before it is trusted —
// the discipline this file learned three times. The false-negative direction is the dangerous
// one: a runtime edge mistaken for a type-only edge would vanish from prong B's set.

describe('the erasure reader drops only the edges TypeScript actually erases', () => {
  const ERASED: readonly [string, string][] = [
    ['import type, braced', `import type { A } from './x.js';`],
    ['import type, default', `import type A from './x.js';`],
    ['import type, namespace', `import type * as N from './x.js';`],
    ['export type, braced', `export type { A } from './x.js';`],
    ['multi-line braced type import', `import type {\n  A,\n  B,\n} from './x.js';`],
  ];
  const KEPT: readonly [string, string][] = [
    ['a plain value import', `import { a } from './x.js';`],
    ['a value import with an INLINE type member', `import { a, type B } from './x.js';`],
    ['a default value import', `import a from './x.js';`],
    ['a namespace import', `import * as n from './x.js';`],
    ['a bare side-effect import', `import './x.js';`],
    ['a dynamic import', `const m = await import('./x.js');`],
    ['a star re-export', `export * from './x.js';`],
    // The safe direction, stated as a fixture: a file holding both keeps the runtime edge.
    ['both spellings to one module', `import type { A } from './x.js';\nimport { b } from './x.js';`],
    // ── THE INVARIANT ABOVE, DRIVEN (fix round 1, the reviewer's own four probes) ──
    // `stripComments` only drops lines that START with a marker, so each of these looks like it
    // should steal the real import's credit. None can: the text that creates the credit creates
    // an occurrence too. These are the demonstration; the paragraph above is the proof.
    ['a trailing comment naming a type import', `import { b } from './x.js'; // import type { A } from './x.js';`],
    ['a block comment on the same line', `import { b } from './x.js'; /* import type { A } from './x.js'; */`],
    ['a type import inside a string literal', `const s = "import type { A } from './x.js';";\nimport { b } from './x.js';`],
    ['a value import AFTER a real type import', `import type { A } from './x.js';\nconst z = 1;\nimport { b } from './x.js';`],
  ];

  for (const [label, code] of ERASED) {
    it(`drops ${label}`, () => {
      expect(runtimeSpecifiersIn(code), `${label} survived erasure: ${code}`).toEqual([]);
    });
  }
  for (const [label, code] of KEPT) {
    it(`keeps ${label}`, () => {
      expect(runtimeSpecifiersIn(code), `${label} was erased and it is real: ${code}`)
        .toContain('./x.js');
    });
  }
});

// ── THE RULE'S OWN VOCABULARY (fix round 3, N3) ──────────────────────────────────────────
// These fixtures no longer enumerate "spellings that bind a door" — that list is unbounded
// and lost three times. They enumerate the ONE spelling that carries a proof, and assert that
// everything else falls on the safe side. Read as a pair with the table above: the walk sees
// nine specifier forms, and eight of those nine can never prove their names.

describe('an edge to the store needs the allowlist unless it PROVES it binds no door', () => {
  const UNPROVEN: readonly [string, string][] = [
    // ── carries a consent name outright ──
    ['braced named', `import { approveOnce } from './store.js';`],
    ['braced and renamed', `import { approveOnce as ok } from './store.js';`],
    ['braced among innocents', `import { getReport, markPosted, createReport } from './store.js';`],
    // ── round 2's escapes: binds everything, proves nothing ──
    ['namespace', `import * as reportStore from './store.js';`],
    ['re-export barrel', `export { approveOnce as consume } from './store.js';`],
    ['star re-export', `export * from './store.js';`],
    ['star re-export, named', `export * as store from './store.js';`],
    // ── round 3's escapes: the codebase's dominant idiom, 502 relative call sites ──
    ['dynamic destructuring a door', `const { approveOnce } = await import('./store.js');`],
    ['dynamic destructuring and renaming', `const { markPosted: mp } = await import('./store.js');`],
    ['dynamic held as a namespace', `const s = await import('./store.js');\nawait s.markExported(id, p);`],
    ['require', `const s = require('./store.js');`],
    // ── and the two forms that bind without naming anything at all ──
    ['bare side-effect', `import './store.js';`],
    ['default', `import store from './store.js';`],
  ];

  for (const [label, code] of UNPROVEN) {
    it(`treats a ${label} edge to the store as needing the allowlist`, () => {
      expect(unprovenEdgesIn(code), `a ${label} edge walks past the census: ${code}`)
        .toContain('./store.js');
    });
  }

  it('lets an innocent BRACED STATIC import through — the one form that proves its names', () => {
    expect(unprovenEdgesIn(`import { getReport, listOpenReports } from './store.js';`)).toEqual([]);
  });

  // ── THE ROW THAT LET F1 THROUGH, REWRITTEN THE WAY THE STANDING RULE ASKS ──
  // The clause above is the one `releaseApproval` walked out of: a braced static import is
  // "innocent" exactly when none of its names is in CONSENT_EXPORTS, so a door missing from that
  // constant is not a hole in the READER, it is a hole in the SUBJECT — and the reader reports
  // green with total confidence. The blind-spot column is written by asking "how would I get
  // past this NOW?", and yesterday's honest answer was: ADD A DOOR IN THE SAME COMMIT AS THE
  // CENSOR'S BLIND SPOT. That answer is closed by the classification clause under prong A, whose
  // own escapes are enumerated beside its fixture table rather than here. These two rows pin the
  // pair so the next author sees both halves: a named door is caught, and an innocent neighbour
  // still passes silently.
  it('a braced static import of the BACKWARDS door is not innocent either (T7 F1)', () => {
    expect(
      unprovenEdgesIn(`import { getReport, releaseApproval } from './store.js';`),
      'handing the approval BACK is moving it, and the census asks who may move it',
    ).toContain('./store.js');
  });

  it('...and aliasing it after import changes nothing, because the EDGE is what is judged', () => {
    // The reviewer's exact probe. The call-site census cannot see `undo(id)`; this one never
    // looks at call sites — it judges the import, which the alias cannot avoid needing.
    const code = `import { releaseApproval } from './store.js';\nconst undo = releaseApproval;`;
    expect(unprovenEdgesIn(code)).toContain('./store.js');
  });

  it('a dynamic import destructuring ONLY getReport is still flagged, and that is the trade', () => {
    // Nothing here touches a door. It is flagged anyway, because `const { [k]: f } = await
    // import(…)` is legal and the namespace object is reachable after the await — a dynamic
    // name is not statically provable. The remedy is to write the braced form, or be reviewed.
    expect(unprovenEdgesIn(`const { getReport } = await import('./store.js');`))
      .toContain('./store.js');
  });

  it('a proof covers one edge, not the file — a braced import beside a dynamic one still fails', () => {
    const code = `import { getReport } from './store.js';\n`
      + `const { approveOnce } = await import('./store.js');`;
    expect(unprovenEdgesIn(code), 'an innocent edge laundered a guilty one').toContain('./store.js');
  });

  it('an unproven edge to some OTHER module is not the store\'s business', () => {
    // The caller resolves specifiers; this reader deliberately does not know what the store is.
    expect(unprovenEdgesIn(`import * as logger from './logger.js';`)).toEqual(['./logger.js']);
  });
});

// ── THE CLASSIFICATION READER'S OWN VOCABULARY (fix round 2, G1) ─────────────────────────
// Pinned in BOTH directions before anything rests on it. The dangerous direction here is the
// FALSE NEGATIVE — a door the reader cannot see is a door that never has to be classified, and
// the census above then reports green about a list that is short. The FALSE POSITIVE direction
// matters too and is the reason this is a bounded scan: `attachDraft` reads `status` in its
// WHERE, and a reader that called that a door would send its next author to widen the rule
// rather than to read it.

describe('the classification reader sees every shape a status-moving door takes', () => {
  const CAUGHT: ReadonlyArray<readonly [string, string]> = [
    ['the plain form', `export function markPosted(id: string) {\n  return transition(\`UPDATE dojo_reports SET status = 'posted', issue_url = ? WHERE id = ? AND status = 'approved'\`, [u, id], id);\n}`],
    // Review's planted door (a): the SET list is a COMMA LIST and status is not first.
    ['status LAST in a comma list', `export function unpostA(id: string) {\n  return transition(\`UPDATE dojo_reports SET updated_at = datetime('now'), status = 'awaiting_approval' WHERE id = ?\`, [id], id);\n}`],
    // Review's planted door (b): not a `function` declaration at all.
    ['an arrow-const export', `export const unpostB = (id: string) => transition(\`UPDATE dojo_reports SET status = 'awaiting_approval' WHERE id = ?\`, [id], id);`],
    ['an exported async function', `export async function slowDoor(id: string) {\n  await db.run(\`UPDATE dojo_reports SET status = 'cancelled' WHERE id = ?\`, id);\n}`],
    ['a multi-line SET list', `export function markExported(id: string) {\n  return transition(\`UPDATE dojo_reports\n      SET export_path = ?, posted_at = datetime('now'),\n          status = 'posted'\n    WHERE id = ? AND status = 'approved'\`, [p, id], id);\n}`],
    // The shape anybody avoiding this census reaches for first.
    ['an export that delegates to a private writer', `function reallyDoIt(id: string) {\n  return db.run(\`UPDATE dojo_reports SET status = 'awaiting_approval' WHERE id = ?\`, id);\n}\nexport const undo = (id: string) => reallyDoIt(id);`],
  ];

  const IGNORED: ReadonlyArray<readonly [string, string]> = [
    // THE FALSE POSITIVE THE NAIVE WIDENING PRODUCES — `attachDraft`'s real text. Its `status`
    // is a PREDICATE: it reads the state to refuse a row that has moved on. Not a door.
    ['attachDraft — status in the WHERE, never in the SET', `export function attachDraft(id: string) {\n  return transition(\`UPDATE dojo_reports\n        SET brief_json = ?, telemetry_json = ?, bundle_path = ?, updated_at = datetime('now')\n      WHERE id = ? AND status = 'drafting'\`, [b, t, p, id], id);\n}`],
    ['a SELECT that reads status', `export function getReport(id: string) {\n  return db.prepare(\`SELECT id, status, lane FROM dojo_reports WHERE id = ?\`).get(id);\n}`],
    ['a status named in a message string', `export function refusal(status: string): string {\n  return \`This report is \${status} and cannot be cancelled.\`;\n}`],
    // A private writer with no exported caller cannot be imported, so it is nobody's door.
    ['a PRIVATE writer nothing exports', `function hidden(id: string) {\n  return db.run(\`UPDATE dojo_reports SET status = 'cancelled' WHERE id = ?\`, id);\n}`],
  ];

  for (const [label, code] of CAUGHT) {
    it(`sees ${label}`, () => {
      expect(statusWriters(code).length, `the reader is blind to ${label}: a door like this could `
        + 'be added to report/store.ts and never have to be classified').toBeGreaterThan(0);
    });
  }

  for (const [label, code] of IGNORED) {
    it(`ignores ${label}`, () => {
      expect(statusWriters(code), `${label} was called a door; the next author will be sent to `
        + 'widen this rule instead of reading it').toEqual([]);
    });
  }

  // ⚠ THE BLIND-SPOT COLUMN, WRITTEN BY ASKING THE QUESTION FRESH RATHER THAN BY EDITING THE
  // OLD SENTENCE. Round 1's answer to "how would I get past this NOW?" was "a transition that
  // never writes `status`" — which was FALSE in the direction that matters (two shapes that do
  // write it walked past), and is only one of the ways through even now. The honest list:
  //
  //   1. TWO HOPS. An export → a private helper → another private writer. One hop is covered;
  //      the second is not, and the remedy if it ever appears is to iterate to a fixed point.
  //   2. SQL ASSEMBLED FROM FRAGMENTS. `SET ${SET_POSTED} WHERE …` puts no `status =` in the
  //      literal. Compensating guard, and the reason this is not urgent: `check-sql-prepares`
  //      requires every prepared statement to be an INLINE LITERAL, so a fragment-assembled
  //      statement fails a blocking gate before it reaches this one.
  //   3. A DOOR THAT MOVES THE APPROVAL WITHOUT WRITING `status`. The status column IS the
  //      approval state, so this is the narrowest of the three — but "narrow" is what round 1
  //      said about its own blind spot, so it is written down rather than dismissed.
  //   4. A lower-case `set status =` inside a string the SQL gate does not prepare. The scan is
  //      case-insensitive, so this one is closed; it is listed because it was checked.

  it('agrees with the store\'s real text — the reader is not measuring a fixture-shaped world', () => {
    const store = fs.readFileSync(path.join(SRC, STORE_REL), 'utf8');
    const found = statusWriters(store);
    expect(found, 'the reader found no doors in the real store — it is broken').not.toEqual([]);
    expect(found, 'attachDraft/editBrief read `status` in a WHERE and must never be classified '
      + 'as doors that MOVE it').not.toContain('attachDraft');
    expect(found).not.toContain('editBrief');
    expect(found).not.toContain('getReport');
  });
});

describe('the walk itself is sound', () => {
  it('reaches a real graph and leaves no unresolved relative specifier', () => {
    expect(CLOSURE.modules.length).toBeGreaterThan(100);
    expect(CLOSURE.modules).toContain('agent/tools/cat/report.ts');
    expect(CLOSURE.modules).toContain('report/gather.ts');
    // A hole in the walk is a module never visited, so everything under it is unmeasured.
    // A census with holes reporting green is a false green.
    expect(CLOSURE.unresolved, `unresolved relative import(s): ${CLOSURE.unresolved.join(', ')}`).toEqual([]);
  });

  it('the runtime closure is a real subset that still reaches everything the tool uses', () => {
    expect(RUNTIME.modules).toContain('agent/tools/cat/report.ts');
    expect(RUNTIME.modules).toContain('report/gather.ts');
    expect(RUNTIME.modules).toContain('report/store.ts');
    expect(RUNTIME.unresolved).toEqual([]);
    // Non-vacuity in both directions: it must be smaller than the over-approximation (or the
    // erasure reader is doing nothing) and it must not have collapsed (or prong B sees nothing).
    expect(RUNTIME.modules.length).toBeLessThan(CLOSURE.modules.length);
    expect(RUNTIME.modules.length).toBeGreaterThan(100);
    for (const m of RUNTIME.modules) expect(CLOSURE.modules).toContain(m);
  });

  it('the gateway is NOT runtime-reachable from the tool — the fact prong B rests on', () => {
    // The whole safety case for measuring prong B on the runtime closure is this one fact. It is
    // pinned rather than assumed, so a real (non-erased) edge from the tool's graph into the
    // server announces itself HERE, with this explanation beside it, rather than as a bare prong
    // B failure someone is tempted to "fix" by editing the allowlist.
    for (const phantom of ['gateway/server.ts', 'gateway/routes/reports.ts', 'gateway/routes/github.ts']) {
      expect(CLOSURE.modules, `${phantom} left the over-approximating walk — re-read N4`)
        .toContain(phantom);
      expect(
        RUNTIME.modules,
        `${phantom} became RUNTIME-reachable from the dojo_report handler. It was a phantom of `
        + 'the static walk (an erased `import type` in gateway/routes/update.ts). Something now '
        + 'imports it for real, and the tool that cannot send may be able to reach the door that '
        + 'can. Read the diff before touching anything else in this file.',
      ).not.toContain(phantom);
    }
  });
});

describe('A — only a named list may consume the owner\'s one approval', () => {
  it('the importers of the consent doors are exactly the allowlist', () => {
    expect(
      consentImporters(),
      'A file holds an edge to report/store.ts that does not PROVE it binds no consent door, '
      + 'and is not named in ALLOWED_CONSENT_CALLERS. approveOnce mints the owner\'s single '
      + 'approval, markPosted and markExported spend it, and releaseApproval hands it back — '
      + 'all four MOVE it, which is the question this census asks (D4).\n'
      + 'Two honest fixes: (1) if the edge is dynamic, namespace, re-export, bare or default, '
      + 'rewrite it as `import { theNames } from \'…/store.js\'` — the braced static form is the '
      + 'only one whose names are statically provable, and an innocent one passes silently; '
      + '(2) if it really does consume an approval — this is the T7 posting route — add it to '
      + 'ALLOWED_CONSENT_CALLERS, and that one-line edit IS the review.',
    ).toEqual([...ALLOWED_CONSENT_CALLERS].sort());
  });

  it('the doors it names are the doors the store actually exports', () => {
    const store = fs.readFileSync(path.join(SRC, STORE_REL), 'utf8');
    for (const name of [...CONSENT_EXPORTS, ...NON_CONSENT_TRANSITIONS]) {
      expect(store, `report/store.ts no longer exports ${name} — this census is guarding a ghost`)
        .toContain(`export function ${name}(`);
    }
  });

  // ── THE OTHER HALF, ADDED IN T7's FIX ROUND — AND IT IS THE HALF F1 NEEDED ──
  // The clause above asks "is every name we police still real?". Nothing asked the converse:
  // "is every real door policed?" `releaseApproval` shipped outside CONSENT_EXPORTS and rode
  // both prongs green, because a list maintained by REMEMBERING to add to it is a list that one
  // day is not added to — and the day it happens is the day a door is written, which is the day
  // the author is thinking about the door and not about the censor.
  //
  // So membership is now derived from the store's own source and must be DECLARED either way. A
  // new transition lands on neither list and fails here, naming itself, with both remedies
  // spelled out. Asked the standing way — "how would I get past this NOW?" — the answer is no
  // longer "add a door in the same commit as the censor's blind spot"; it is "give the store a
  // transition that does not write `status`", which cannot move an approval by definition.
  it('every status-moving door in the store is classified as consent-moving or not', () => {
    // The reader is `statusWriters`, pinned in both directions by its own fixture table above —
    // including the two shapes round 1's inline version could not see and the one false positive
    // the obvious widening produces.
    const movers = statusWriters(fs.readFileSync(path.join(SRC, STORE_REL), 'utf8'));
    expect(movers.length, 'no status-moving door was found at all — this reader is broken')
      .toBeGreaterThan(3);
    expect(
      movers.sort(),
      'report/store.ts exports a transition that writes `status` and this file classifies it as '
      + 'neither consent-moving nor not. Two honest fixes: (1) if it can move a report toward or '
      + 'away from delivery, add it to CONSENT_EXPORTS — that one-word edit IS the review, and '
      + 'note that a BACKWARDS door counts (T7 F1: the question is who may MOVE the approval, '
      + 'not who may spend it); (2) if it cannot, add it to NON_CONSENT_TRANSITIONS with the '
      + 'reason, beside the two that are already there.',
    ).toEqual([...CONSENT_EXPORTS, ...NON_CONSENT_TRANSITIONS].sort());
  });
});

describe('B — nothing behind the report tool can consume one', () => {
  it('no module RUNTIME-reachable from the handler imports a consent door', () => {
    // N4: measured on the RUNTIME closure, because an erased `import type` is not a way to reach
    // anything. The clause directly above pins the fact that makes this safe; prong C keeps the
    // over-approximation, so nothing is traded away.
    const inClosure = consentImporters().filter(f => RUNTIME.modules.includes(f));
    expect(
      inClosure,
      `these modules are reachable from the dojo_report handler AT RUNTIME AND hold an unproven `
      + `edge to report/store.ts: ${inClosure.join(', ')}. The tool must not be able to reach the `
      + `approval it exists to ask for — not even through a dynamic import.`,
    ).toEqual([]);
  });
});

describe('C — no new way out has appeared behind the report tool', () => {
  it('the handler imports exactly its declared list — one hop, pinned', () => {
    expect(
      [...new Set(specifiersOf(HANDLER))].sort(),
      'cat/report.ts gained or lost an import. Every module it can reach directly is pinned '
      + 'because a blacklist of five names is what this file exists to replace.',
    ).toEqual([...HANDLER_IMPORTS].sort());
  });

  it('the gather imports exactly its declared list — one hop, pinned', () => {
    expect([...new Set(specifiersOf(path.join(SRC, 'report', 'gather.ts')))].sort())
      .toEqual([...GATHER_IMPORTS].sort());
  });

  it('the fetch-bearing modules in the closure are exactly the recorded manifest', () => {
    const fetchy = CLOSURE.modules
      .filter(m => /\bfetch\s*\(/.test(fs.readFileSync(path.join(SRC, m), 'utf8')));
    const added = fetchy.filter(m => !FETCH_BEARING_IN_CLOSURE.includes(m));
    const gone = FETCH_BEARING_IN_CLOSURE.filter(m => !fetchy.includes(m));
    expect(
      added,
      `NEW outbound module(s) reachable from the dojo_report handler: ${added.join(', ')}. `
      + 'A tool whose whole claim is that it cannot send just grew a new way out. Read the diff '
      + 'and say why before adding a name to FETCH_BEARING_IN_CLOSURE.',
    ).toEqual([]);
    expect(gone, `manifest names a module no longer in the closure (stale): ${gone.join(', ')}`).toEqual([]);
  });
});
