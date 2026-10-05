// ════════════════════════════════════════════════════════════════════════════════════════
// ONLY THE AUDITED DOOR CAN REACH THE WIRE (v3.3 t99 — the egress census covers the WHOLE
// handler again).
//
// ── WHY THIS FILE EXISTS, STATED AS THE FAILURE IT REPLACES ──
// The DOJO-REPORT feature ships a user's diagnostic bundle to a public page under a
// consent-and-privacy contract, and two censuses exist to prove the contract structurally:
// `agent/tools/__tests__/the-report-tool-cannot-post.test.ts` reads the handler's own text,
// and `agent/tools/__tests__/the-report-tool-reaches-no-new-door.test.ts` censuses the graph
// behind it in three prongs. Between them they promise that ONLY the audited door performs
// network egress, and that nothing in the handler's reach can post a user's data elsewhere.
//
// That promise had a hole, and it was planted and measured twice:
//
//   ROUND 1 (t95's finding, fix-round-2 review M1). A new module imported by
//   `cat/report-prose.ts` opening `https.request({ host: 'api.github.com', method: 'POST' })`
//   rode BOTH censuses green at 94/94. The one-hop import pin read `cat/report.ts` and not
//   its prose half, so the split the size fix made was the gap. That half is CLOSED: the pin
//   now covers both files of the handler (`PROSE_IMPORTS`), and the same plant reproduced at
//   this HEAD goes RED on it.
//
//   ROUND 2 (this lane, measured before a line of this file was written). The pin is EXACT
//   but it is ONE HOP. So the plant moved one module deeper: a new `report/narrative-tint.ts`
//   imported by `report/window.ts` — itself a pinned, blessed, entirely innocent one-hop
//   import of the handler — opening `https.request(…, { method: 'POST' })` and called from
//   `resolveWindow`, which every `gather` runs. BOTH CENSUSES STAYED GREEN AT 94/94. Nothing
//   was caught: the one-hop pins do not read `window.ts`'s imports, and prong C's manifest
//   greps `\bfetch\s*\(`, to which `node:https` is invisible (the same blindness §L93.5
//   recorded as the two-hop prong-C limit).
//
// So the guard was a pin on the two files somebody thought to pin, in front of a 570-module
// graph, against a vocabulary of one word. What was missing is not another name on a list:
//
//   · the walk has to be TRANSITIVE, so the depth of the wiring stops mattering, and
//   · the vocabulary has to be CLOSED over ways out, so the spelling stops mattering.
//
// ── WHAT THIS FILE ASSERTS ──
// One walk, four claims, each a different question:
//
//   E1  INSIDE THE FEATURE'S OWN DIRECTORIES, EGRESS IS EXACTLY THE AUDITED DOORS. Every
//       module reachable from the handler at ANY depth whose path lies in `report/**`,
//       `agent/tools/cat/**` or `github/**` is read, and the egress-bearing set must equal
//       `AUDITED_DOORS` exactly. This is the privacy promise written as a clause: a new way
//       out wired in at one hop, two hops or five fails here, and so does the audited door
//       losing its egress — the door must still be the one that posts.
//   E1b THE AUDITED DOOR STILL POSTS, in shape AND application: a `fetch(` whose URL is the
//       issues endpoint, a `method: 'POST'` inside that same call, and the host constant it
//       is built from. A clause satisfiable by the prose above the call would be testing the
//       comment (G4), so the slice is cut from the call itself.
//   E2  NO NEW WAY OUT ANYWHERE BEHIND THE TOOL. The egress-bearing modules in the WHOLE
//       closure are pinned as an exact manifest under the closed vocabulary. This is prong
//       C's `fetch(` manifest widened to every spelling, and it is what catches a plant
//       outside the feature's own directories.
//   E3  THE SHELL IS A WAY OUT TOO. `exec('curl …')` is invisible to every network-module
//       vocabulary there is, so a `child_process` importer that also names a net binary is
//       its own small manifest.
//   E4  AND THE WALK'S OWN SCOPE IS DECLARED. Every production module under `report/` is
//       reachable from the handler today; one that is not is UNMEASURED by E1/E2 and has to
//       say so on `REPORT_MODULES_NOT_REACHABLE`, so the day it is wired up the census that
//       starts covering it is read by somebody.
//
// ── WHAT THIS FILE HONESTLY CANNOT SEE ──
// Written by asking "how would I get past this NOW?", not by editing an older sentence. Each
// row is a cannot-see with its reason; none of them is described as covered.
//
//   1. A STRING-BUILT SPECIFIER. `require('nod' + 'e:https')`, or a specifier read from a
//      variable or a config value. The reader matches literal specifiers only. Closing it
//      means evaluating the module, which a census must never do.
//   2. A WORKER, A `vm`, OR `eval`. `new Worker(code)` / `vm.runInNewContext` can hold any
//      import this file never sees. `node:worker_threads` and `node:vm` are NOT in the
//      vocabulary: measured zero occurrences in the closure, and adding them would pin a
//      manifest of legitimate workers rather than prove anything about egress.
//   3. `process.binding('http_parser')` AND FRIENDS — IN THE VOCABULARY, closed at zero
//      cost: zero occurrences in this closure, so the entry is free and the class is shut.
//   4. AN ALREADY-DECLARED DOOR GAINING A NEW CALL SITE. E2 is a set of MODULES; a second
//      `fetch` inside `services/ollama.ts` is invisible to it. E1 is what makes this
//      tolerable: inside the feature's own code the set is two files, so the only module
//      that can quietly grow a call is one already audited for carrying content.
//   5. A SHELL EGRESS THROUGH A BINARY NOT ON THE LIST — `python3 -c`, `osascript`, a
//      vendored helper. E3's list is six names (`curl`, `wget`, `nc`, `netcat`, `ssh`,
//      `scp`, `rsync`); a `child_process` importer that reaches the network some other way
//      is not caught. The honest bound is "the shapes this tree actually writes".
//   6. THE DASHBOARD. `packages/dashboard` is a different package and not in this graph. The
//      card's own posting path is censused from the other side in
//      `gateway/routes/__tests__/only-the-card-can-post-a-report.test.ts`.
//   7. A TRAILING COMMENT. `stripComments` drops only lines that START with a marker, so
//      `const x = 1; // import https from 'node:https'` counts as an edge. That is an
//      OVER-read: it can only add a module to a manifest, never remove one, so it fails
//      safe — and a RED that has to be argued is the direction this file wants to be wrong in.
//   8. RUNTIME REACHABILITY. The walk over-approximates deliberately (an erased `import type`
//      is counted), so a module here may not be reachable when the process runs. Same
//      direction as the sibling census's prong C, and for the same reason: a type-only edge
//      becomes a real one in a one-word deletion.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..', '..');

/** The handler is TWO files since the size fix, and a census that reads one has a hole
 *  exactly where the split is — which is round 1 of this file's own history. */
const HANDLER_ENTRIES: readonly string[] = [
  'agent/tools/cat/report.ts',
  'agent/tools/cat/report-prose.ts',
];

/**
 * THE CLOSED EGRESS VOCABULARY — bare module specifiers whose whole job is leaving the box.
 * Closed over the ways OUT rather than open over the names somebody remembered: `node:https`
 * is what rode both censuses green, and listing it alone would be the five-name blacklist
 * this feature's censuses were written to replace.
 *
 * ⚠ THE SUBPATH IS PART OF THE CLOSURE, and it is here because the first cut did not have it:
 * `node:dns/promises` is an ordinary spelling of the same module and `^(?:node:)?dns$` is
 * blind to it, which is precisely the one-spelling-out-of-six defect this feature's censuses
 * have been beaten by three times. The trailing `(?:\/.*)?` costs nothing in the other
 * direction — a relative specifier starts with `.` and never reaches this test, and a package
 * called `requestly` is not matched by `^request(?:\/.*)?$`.
 */
const EGRESS_SPECIFIER =
  /^(?:node:)?(?:http|https|http2|net|tls|dgram|dns)(?:\/.*)?$|^(?:undici|node-fetch|axios|got|superagent|request|ws|socket\.io-client|eventsource)(?:\/.*)?$/;

/** ...and the call shapes that need no import at all. The global `fetch` is the one prong C
 *  already knew; the rest are here because a vocabulary with a hole in it is a pin, not a
 *  vocabulary. `process.binding` is free — zero occurrences — and shuts a whole class. */
const EGRESS_CALLS: readonly [string, RegExp][] = [
  ['fetch(', /\bfetch\s*\(/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['new WebSocket(', /\bnew\s+WebSocket\s*\(/],
  ['sendBeacon(', /\bsendBeacon\s*\(/],
  ['process.binding(', /\bprocess\s*\.\s*binding\s*\(/],
];

/** THE SHELL VOCABULARY (E3). A `child_process` edge is not egress by itself — this tree
 *  spawns `sips`, `ollama`, `sqlite3` and a dozen other local tools — so the clause is the
 *  PAIR: the import, and a net binary named in the same file. */
const CHILD_PROCESS_SPECIFIER = /^(?:node:)?child_process$/;
const NET_BINARY = /\b(?:curl|wget|nc|netcat|ssh|scp|rsync)\b/;

/** The DOJO-REPORT feature's own code: the store and collectors, the whole tool directory the
 *  handler lives in (so a sibling planted beside it is in scope — that was round 1's plant),
 *  and the GitHub delivery modules. */
const FEATURE_DIRS: readonly RegExp[] = [
  /^report\//, /^agent\/tools\/cat\//, /^github\//,
];

/**
 * THE AUDITED DOORS — the only two modules in the feature's own code that may reach the wire.
 *
 *   `github/issues.ts`      the delivery door. `postIssue` carries a rendered brief to
 *                           `POST /repos/:owner/:repo/issues`, and it is the ONLY thing in
 *                           the tree that can turn an approved report into an issue. What
 *                           gates it is the owner's consent, not this file: its single caller
 *                           `report/post.ts` refuses every row that is not already
 *                           `approved`, and only `approveOnce` — called from the route behind
 *                           the Post button — can produce one (D4).
 *   `github/device-flow.ts` GitHub's OAuth device flow: `/login/device/code`,
 *                           `/login/oauth/access_token` and `GET /user`. None of those
 *                           endpoints accepts content, no function here takes a report, a
 *                           brief or an agent id, and its four entry points are reachable
 *                           only from `POST /api/github/*` behind the owner's own session.
 *
 * An addition to this list is a grant of posting rights over a user's diagnostic bundle and
 * must be read as one. The sibling census's `FETCH_BEARING_IN_CLOSURE` note carries the two
 * questions that separate a phantom from a way out; both of these were answered there.
 */
const AUDITED_DOORS: readonly string[] = ['github/device-flow.ts', 'github/issues.ts'];

/**
 * E2's MANIFEST — every module in the handler's closure that holds egress under the closed
 * vocabulary. A RECORD OF WHAT IS, not a permission list: the engine's graph is broad and
 * most of these are reachable only because the tool registry pulls in the whole toolbox.
 * THE GUARD IS THE DELTA. A name appearing here that was not here before means a new way out
 * became reachable from a tool whose entire purpose is that it cannot send — read the diff
 * and say why before editing this list.
 *
 * This is prong C's `fetch(`-only manifest widened to the closed vocabulary. The three
 * entries carrying a non-`fetch` marker are the proof the widening is not decoration:
 * `agent/model.ts` (undici), `agent/net-guard.ts`, `screen-share/bridge.ts`,
 * `screen-share/manager.ts` and `voice/stt-service.ts` (`node:net`) are modules prong C
 * could never have seen as egress at all.
 */
const EGRESS_IN_CLOSURE: readonly string[] = [
  'agent/model.ts',                     // fetch(, import 'undici'
  'agent/net-guard.ts',                 // import 'node:net'
  'agent/site-snapshot.ts',             // fetch(
  'agent/tools/definitions.ts',         // fetch(
  'agent/web-tools.ts',                 // fetch(
  'gateway/routes/config.ts',           // fetch(
  'gateway/routes/setup-deps.ts',       // fetch(
  'gateway/routes/system.ts',           // fetch(
  'gateway/routes/update.ts',           // fetch(
  'github/device-flow.ts',              // fetch( — AUDITED DOOR
  'github/issues.ts',                   // fetch( — AUDITED DOOR
  'google/auth.ts',                     // fetch(
  'google/client.ts',                   // fetch(
  'google/tools-slides.ts',             // fetch(
  'memory/embeddings.ts',               // fetch(
  'microsoft/auth.ts',                  // fetch(
  'microsoft/client.ts',                // fetch(
  'microsoft/graph-fetch.ts',           // fetch(
  'screen-share/bridge.ts',             // import 'node:net'
  'screen-share/manager.ts',            // import 'node:net'
  'services/audio-generation.ts',       // fetch(
  'services/capabilities.ts',           // fetch(
  'services/image-generation.ts',       // fetch(
  'services/litellm-pricing-sync.ts',   // fetch(
  'services/num-ctx-calculator.ts',     // fetch(
  'services/ollama.ts',                 // fetch(
  'services/transcription.ts',          // fetch(
  'services/video-generation.ts',       // fetch(
  'twilio/client.ts',                   // fetch(
  'twilio/sms-inbound.ts',              // fetch(
  'update/artifact-integrity.ts',       // fetch(
  'voice/model-manager.ts',             // fetch(
  'voice/smart-turn.ts',                // fetch(
  'voice/stt-service.ts',               // fetch(, import 'node:net'
];

/** E3's MANIFEST. Three modules in the closure import `child_process` AND name a net binary;
 *  none is in the feature's own code, and all three are the update/migration machinery that
 *  fetches and syncs a release. Same reading as E2: the guard is the delta. */
const SHELL_EGRESS_IN_CLOSURE: readonly string[] = [
  'gateway/routes/update.ts',           // curl, rsync — the updater
  'migration/step-classify.ts',         // curl, wget — classifies a migration step's command
  'services/watchdog-refresh.ts',       // rsync — refreshes the watchdog's copy
];

/** E4's REGISTER. A production module under `report/` that the handler cannot reach is
 *  UNMEASURED by E1 and E2, so it is declared rather than absent. Empty today: all 18
 *  modules under `report/` are reachable from the handler. */
const REPORT_MODULES_NOT_REACHABLE: readonly string[] = [];

// ── the walk ────────────────────────────────────────────────────────────────────────────
// The specifier reader is the sibling census's, deliberately unchanged: it is the one piece
// of this machinery that has been through four rounds of review (a bare side-effect import,
// a backtick specifier, a backreferenced delimiter, and a newline exclusion that stopped it
// reading the prose between two templates as a module name). A second, subtly different
// reader in the same feature is how two guards end up pinned against different vocabularies,
// which is exactly the defect N3 records.
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s*)(['"`])([^'"`\n]+)\1/g;
const isComment = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line);
const stripComments = (code: string): string =>
  code.split('\n').filter(l => !isComment(l)).join('\n');

/** Every module specifier in a piece of code, in any spelling that creates an EDGE. */
function specifiersIn(code: string): string[] {
  return [...stripComments(code).matchAll(SPEC)].map(m => m[2]);
}

/**
 * THE EGRESS READER. Returns the markers found in one module's TEXT — never by importing it:
 * importing a module executes its side effects, and a census that boots the thing it is
 * auditing is not a census.
 */
function egressMarkersIn(code: string): string[] {
  const clean = stripComments(code);
  const marks: string[] = [];
  for (const spec of specifiersIn(clean)) {
    if (EGRESS_SPECIFIER.test(spec)) marks.push(`import '${spec}'`);
  }
  for (const [label, re] of EGRESS_CALLS) if (re.test(clean)) marks.push(label);
  return [...new Set(marks)].sort();
}

/** The E3 pair: a `child_process` edge AND a net binary named in the same file. */
function shellEgressIn(code: string): boolean {
  const clean = stripComments(code);
  return specifiersIn(clean).some(s => CHILD_PROCESS_SPECIFIER.test(s)) && NET_BINARY.test(clean);
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

/** THE TRANSITIVE WALK — to a fixed point, from every entry the handler is made of. A hole in
 *  it is a module never visited, and everything under that module is then unmeasured, so an
 *  unresolved relative specifier is a failing clause rather than a swallowed miss. */
function closureFrom(entries: readonly string[]): { modules: string[]; unresolved: string[] } {
  const seen = new Set<string>();
  const unresolved: string[] = [];
  const stack = entries.map(e => path.join(SRC, e));
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of specifiersIn(fs.readFileSync(file, 'utf8'))) {
      const resolved = resolveSpec(file, spec);
      if (resolved) stack.push(resolved);
      else if (spec.startsWith('.')) unresolved.push(`${path.relative(SRC, file)} -> ${spec}`);
    }
  }
  return {
    modules: [...seen].map(f => path.relative(SRC, f)).sort(),
    unresolved: [...new Set(unresolved)],
  };
}

const CLOSURE = closureFrom(HANDLER_ENTRIES);
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');
const inFeature = (rel: string): boolean => FEATURE_DIRS.some(d => d.test(rel));
const egressBearing = (mods: readonly string[]): string[] =>
  mods.filter(m => egressMarkersIn(read(m)).length > 0);

// ⚠ THE READERS ARE TESTED BEFORE ANYTHING THEY READ IS TRUSTED. Every claim below rests on
// two regexes seeing what is actually written in this repo, and the feature's own history is
// three rounds of a census reading one spelling out of six and reporting green. So the
// vocabulary is pinned as fixtures, here, where a missing form is a FAILING CLAUSE rather
// than a silent hole in a 570-module walk.

describe('the specifier reader sees every import spelling that creates an edge', () => {
  const FORMS: readonly [string, string][] = [
    ['named', `import { a } from './x.js';`],
    ['default', `import d from './x.js';`],
    ['namespace', `import * as n from './x.js';`],
    ['bare side-effect', `import './x.js';`],
    ['dynamic', `const m = await import('./x.js');`],
    ['require', `const m = require('./x.js');`],
    ['dynamic with backticks', 'const m = await import(`./x.js`);'],
    ['require with backticks', 'const m = require(`./x.js`);'],
    ['re-export named', `export { a } from './x.js';`],
    ['re-export star', `export * from './x.js';`],
    ['re-export star as', `export * as n from './x.js';`],
  ];
  for (const [label, code] of FORMS) {
    it(`sees a ${label} import`, () => {
      expect(specifiersIn(code), `the walk is blind to the ${label} form: ${code}`)
        .toEqual(['./x.js']);
    });
  }
  it('ignores a specifier that only appears in prose', () => {
    expect(specifiersIn(`// an old \`await import('node:https')\` hack\nconst x = 1;`)).toEqual([]);
  });
});

describe('the egress reader is closed over the ways out, in both directions', () => {
  const CAUGHT: readonly [string, string][] = [
    // THE PLANT THAT RODE BOTH CENSUSES GREEN, TWICE. This row is the whole lane.
    ['a node:https import', `import https from 'node:https';`],
    ['...and the unprefixed spelling', `import https from 'https';`],
    ['a node:http import', `import http from 'node:http';`],
    ['http2', `import http2 from 'node:http2';`],
    ['a raw socket', `import net from 'node:net';`],
    ['a TLS socket', `import tls from 'node:tls';`],
    ['a UDP socket', `import dgram from 'node:dgram';`],
    ['a DNS lookup', `import dns from 'node:dns';`],
    ['...and its promises SUBPATH, which the first cut of this regex missed', `import dns from 'node:dns/promises';`],
    ['an egress package SUBPATH', `import { fetch } from 'undici/fetch';`],
    ['undici', `import { request } from 'undici';`],
    ['node-fetch', `import fetchIt from 'node-fetch';`],
    ['axios', `import axios from 'axios';`],
    ['got', `import got from 'got';`],
    ['the ws client', `import WS from 'ws';`],
    ['an eventsource', `import ES from 'eventsource';`],
    // The spellings that are not a static import at all.
    ['a REQUIRED socket module', `const net = require('node:net');`],
    ['a DYNAMIC https import', `const h = await import('node:https');`],
    ['a BACKTICK dynamic import of https', 'const h = await import(`node:https`);'],
    ['a RE-EXPORT of an egress package', `export * from 'undici';`],
    ['a BARE side-effect import of one', `import 'node-fetch';`],
    // No import needed.
    ['the global fetch', `const r = await fetch(url, { method: 'POST' });`],
    ['an XHR', `const x = new XMLHttpRequest();`],
    ['a WebSocket', `const s = new WebSocket('wss://x.invalid');`],
    ['a beacon', `navigator.sendBeacon('https://x.invalid', body);`],
    ['process.binding', `const p = process.binding('http_parser');`],
  ];
  const IGNORED: readonly [string, string][] = [
    // THE FALSE-POSITIVE DIRECTION MATTERS TOO: a reader that calls innocent code egress
    // sends its next author to widen the rule instead of reading it.
    ['a local file read', `import fs from 'node:fs';`],
    ['...and ITS promises subpath, so the subpath widening did not overreach', `import fs from 'node:fs/promises';`],
    ['a path join', `import path from 'node:path';`],
    ['a hash', `import { createHash } from 'node:crypto';`],
    ['a uuid', `import { v4 } from 'uuid';`],
    ['a LOCAL module whose name merely contains https', `import { x } from './https-helper.js';`],
    ['a URL in a string constant — the audited door holds one', `const API = 'https://api.github.com';`],
    ['a URL in prose', `// POSTs to https://api.github.com/repos/x/y/issues\nconst x = 1;`],
    ['an egress import named only in a comment', `// import https from 'node:https';\nconst x = 1;`],
    ['a word ENDING in fetch', `const v = await prefetch(key);`],
    ['a child_process import on its own — E3 is the PAIR, not the import', `import { execFile } from 'node:child_process';\nexecFile('sips', args);`],
  ];
  for (const [label, code] of CAUGHT) {
    it(`sees ${label}`, () => {
      expect(egressMarkersIn(code), `the vocabulary is blind to ${label}: ${code}. A module like `
        + 'this could be wired into the report handler and reach the wire unmeasured')
        .not.toEqual([]);
    });
  }
  for (const [label, code] of IGNORED) {
    it(`does not call ${label} egress`, () => {
      expect(egressMarkersIn(code), `${label} was called egress; the next author will be sent to `
        + 'widen this rule instead of reading it').toEqual([]);
    });
  }
  it('reads the real audited door as egress — not a fixture-shaped world', () => {
    expect(egressMarkersIn(read('github/issues.ts'))).toContain('fetch(');
  });
  it('sees the shell pair, and only as a pair', () => {
    expect(shellEgressIn(`import { exec } from 'node:child_process';\nexec('curl -s ' + url);`))
      .toBe(true);
    expect(shellEgressIn(`import { exec } from 'node:child_process';\nexec('sips -Z 64 ' + f);`))
      .toBe(false);
    expect(shellEgressIn(`const cmd = 'curl -s https://x.invalid';`)).toBe(false);
  });
});

describe('the walk is transitive and leaves nothing unmeasured', () => {
  it('reaches a real graph from BOTH files the handler is made of', () => {
    expect(CLOSURE.modules.length).toBeGreaterThan(100);
    for (const entry of HANDLER_ENTRIES) expect(CLOSURE.modules).toContain(entry);
    expect(HANDLER_ENTRIES.length, 'the handler is two files; a walk that seeds one has a hole '
      + 'exactly where the split is').toBe(2);
  });

  it('goes deeper than one hop — the limit this file exists to pass', () => {
    // One hop from the handler: `report/window.ts`, `report/telemetry-build.ts`. TWO hops:
    // `report/telemetry-whitelist.ts`, reachable only THROUGH telemetry-build. That is the
    // depth round 2's plant lived at, so the walk must be able to prove it gets there.
    expect(CLOSURE.modules).toContain('report/telemetry-build.ts');
    expect(CLOSURE.modules).toContain('report/telemetry-whitelist.ts');
    expect(specifiersIn(read('agent/tools/cat/report.ts')).join(' '))
      .not.toContain('telemetry-whitelist');
  });

  it('leaves no unresolved relative specifier', () => {
    expect(
      CLOSURE.unresolved,
      `unresolved relative import(s): ${CLOSURE.unresolved.join(', ')}. Everything under an `
      + 'unvisited module is UNMEASURED, and a census with holes reporting green is a false green.',
    ).toEqual([]);
  });
});

describe('E1 — inside the feature\'s own code, only the audited door reaches the wire', () => {
  it('the egress-bearing modules in the feature are exactly the audited doors', () => {
    const feature = CLOSURE.modules.filter(inFeature);
    expect(feature.length, 'the feature scope matched almost nothing — the directory patterns '
      + 'have drifted and this clause is measuring an empty set').toBeGreaterThan(20);
    const found = egressBearing(feature);
    expect(
      found,
      'The DOJO-REPORT feature\'s own code reaches the wire from somewhere other than the '
      + 'audited door. Every module below is reachable from the report handler at SOME depth '
      + 'and holds egress under the closed vocabulary:\n'
      + found.map(m => `  ${m}  <<${egressMarkersIn(read(m)).join(', ')}>>`).join('\n')
      + '\nThe feature ships a user\'s diagnostic bundle to a PUBLIC page under a consent '
      + 'contract, and the whole of that contract is that ONLY the audited door sends, only '
      + 'after the owner pressed Post. A new way out here is the exfiltration shape these '
      + 'censuses exist to make impossible — one hop below the prose rode both of them green '
      + 'at 94/94 twice (t95 M1, then two hops deep at this lane\'s HEAD).\n'
      + 'If a name is MISSING instead: the audited door lost its egress, and the door that is '
      + 'supposed to be the only one that posts no longer posts. Read E1b.',
    ).toEqual([...AUDITED_DOORS].sort());
  });

  it('the audited doors are inside the scope this clause measures', () => {
    // Non-vacuity in the other direction: if the doors fell OUT of the feature patterns the
    // clause above would be asserting `[] === []` about a scope with nothing in it.
    for (const door of AUDITED_DOORS) {
      expect(inFeature(door), `${door} is no longer inside FEATURE_DIRS`).toBe(true);
      expect(CLOSURE.modules, `${door} left the handler's closure`).toContain(door);
    }
  });
});

describe('E1b — the audited door still posts, and it posts to the audited place', () => {
  it('holds the issues POST in shape and in application', () => {
    const src = stripComments(read('github/issues.ts'));
    // The SHAPE and its APPLICATION, cut from the call itself: a clause satisfiable by the
    // paragraph above the call would be testing the comment (G4).
    const calls = [...src.matchAll(/\bfetch\s*\(([\s\S]{0,400}?)\)\s*;/g)].map(m => m[1]);
    expect(calls.length, 'no fetch call could be sliced out of the audited door at all')
      .toBeGreaterThan(0);
    const posts = calls.filter(c => /\/repos\/\$\{repo\}\/issues`/.test(c) && /method:\s*'POST'/.test(c));
    expect(
      posts.length,
      'github/issues.ts no longer holds a POST to `${GITHUB_API}/repos/${repo}/issues` with '
      + '`method: \'POST\'` inside that same call. This is the audited door — the one place a '
      + 'user\'s approved report is allowed to leave the box. If the delivery moved, it moved '
      + 'to a module E1 has not blessed, and E1 should have failed beside this; if it was '
      + 'deleted, the feature no longer delivers. Either way the privacy promise this file '
      + 'states is no longer about this door.',
    ).toBeGreaterThan(0);
  });

  it('builds that URL from the GitHub API host, not a redirect of someone else\'s choosing', () => {
    expect(stripComments(read('github/issues.ts')))
      .toContain(`const GITHUB_API = 'https://api.github.com'`);
  });
});

describe('E2 — no new way out has appeared anywhere behind the report tool', () => {
  it('the egress-bearing modules in the closure are exactly the recorded manifest', () => {
    const found = egressBearing(CLOSURE.modules);
    const added = found.filter(m => !EGRESS_IN_CLOSURE.includes(m));
    const gone = EGRESS_IN_CLOSURE.filter(m => !found.includes(m));
    expect(
      added,
      'NEW egress-bearing module(s) reachable from the dojo_report handler:\n'
      + added.map(m => `  ${m}  <<${egressMarkersIn(read(m)).join(', ')}>>`).join('\n')
      + '\nA tool whose whole claim is that it cannot send just grew a new way out. If it is '
      + 'inside the feature\'s own code, E1 failed too and THAT is the finding. If it is '
      + 'elsewhere in the engine, read the diff and say why before adding a name here — the '
      + 'two questions that separate a phantom edge from a way out are (1) is it reachable at '
      + 'runtime and (2) does an exported function carry caller-supplied content to the wire.',
    ).toEqual([]);
    expect(
      gone,
      `the manifest names module(s) that no longer hold egress (stale): ${gone.join(', ')}. `
      + 'A stale guard teaches readers to ignore it — delete the lines.',
    ).toEqual([]);
  });

  it('the manifest is not quietly a fetch-only list — the widening earns its keep', () => {
    // Round 2's plant was `node:https`, invisible to `\bfetch\s*\(`. If every entry here is a
    // `fetch(` entry, the vocabulary is not being exercised by the real tree and a reviewer
    // should know that before trusting it.
    const nonFetch = EGRESS_IN_CLOSURE
      .filter(m => !egressMarkersIn(read(m)).some(k => k === 'fetch('));
    expect(nonFetch.length, 'no module in the manifest is egress by anything other than '
      + '`fetch(` — the closed vocabulary is unexercised').toBeGreaterThan(0);
  });
});

describe('E3 — the shell is a way out too', () => {
  const shellFound = (): string[] => CLOSURE.modules.filter(m => shellEgressIn(read(m))).sort();

  it('the shell-egress modules in the closure are exactly the recorded manifest', () => {
    const found = shellFound();
    expect(
      found,
      'The set of modules reachable from the report handler that import `child_process` AND '
      + 'name a net binary has changed. `exec(\'curl …\')` is a way out that no network-module '
      + 'vocabulary can see, so it is its own clause. If the new name is in the feature\'s own '
      + 'code, treat it exactly as an E1 failure: a user\'s bundle must leave by the audited '
      + 'door or not at all.',
    ).toEqual([...SHELL_EGRESS_IN_CLOSURE].sort());
  });

  // ⚠ THIS CLAUSE ASKS THE FOUND SET, NOT THE CONSTANT, AND THE DIFFERENCE IS THE WHOLE
  // POINT. Written against `SHELL_EGRESS_IN_CLOSURE` it would be a statement about a list
  // somebody maintains by remembering — a feature module that shelled out to `curl` would
  // fail only the exact-set clause above and this one would report green about it, which is
  // the same defect as a census that reads one spelling out of six.
  it('...and nothing in the feature\'s own code shells out to the network', () => {
    const inside = shellFound().filter(inFeature);
    expect(
      inside,
      `the DOJO-REPORT feature's own code imports child_process and names a net binary: `
      + `${inside.join(', ')}. A user's bundle must leave by the audited door or not at all, `
      + 'and `exec(\'curl …\')` is a way out that no network-module vocabulary can see.',
    ).toEqual([]);
    // Non-vacuity: the declared manifest must agree with it, so a name cannot be parked on
    // the constant to quieten the clause above while sitting inside the feature.
    expect(SHELL_EGRESS_IN_CLOSURE.filter(inFeature)).toEqual([]);
  });
});

describe('E4 — the walk\'s scope is declared, so an unwired module is not a silent gap', () => {
  it('every production module under report/ is reachable from the handler', () => {
    const onDisk = fs.readdirSync(path.join(SRC, 'report'))
      .filter(f => /\.tsx?$/.test(f))
      .map(f => `report/${f}`)
      .sort();
    expect(onDisk.length, 'report/ looks empty — this clause is reading the wrong directory')
      .toBeGreaterThan(10);
    const unreachable = onDisk.filter(m => !CLOSURE.modules.includes(m));
    expect(
      unreachable,
      `module(s) under report/ that the handler cannot reach: ${unreachable.join(', ')}. `
      + 'They are UNMEASURED by E1 and E2 — an unreachable module can hold any egress it likes '
      + 'and this file will not see it, which is correct (it is not wired up) and dangerous '
      + '(the day it is wired up, nobody re-reads it). Two honest fixes: (1) wire it up, and '
      + 'this clause goes green while E1/E2 start covering it; (2) if it is deliberately not '
      + 'reachable, name it on REPORT_MODULES_NOT_REACHABLE with the reason, and that one-line '
      + 'edit IS the review.',
    ).toEqual([...REPORT_MODULES_NOT_REACHABLE].sort());
  });
});
