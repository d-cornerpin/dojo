#!/usr/bin/env node
// ════════════════════════════════════════
// THE BOOT WROTE EVERY TOOL MANUAL IT OWED — ASKED OF THE BOX THAT JUST BOOTED.
//
// ── WHY THIS EXISTS (installed-box audit, 2026-09-26) ──
// `tools/index-generator.ts` writes one `~/.dojo/tools/<tool>.md` per registered
// tool at boot, and `load_tool_docs` serves them. The failure this guards is
// SILENT BY CONSTRUCTION: a stale manual reads exactly like a current one. An
// unwritable docs directory does not make `mkdirSync(…, {recursive:true})` throw —
// the directory already exists — so the box logged one `warn` per tool, counted
// only successes, and went on serving the PREVIOUS version's manuals for ever.
// Every agent read them as current.
//
// The runtime half of that is fixed and shipped: `tools/doc-freshness.ts` compares
// what was written against what the registry declares, says so at ERROR, and the
// numbers reach `/api/health` as `data.toolDocs` and the dashboard's Vitals card
// (`@dojo/shared`'s `toolDocsShortfall` is the one wording both read). What was
// still missing is the question nobody asks at the one moment it is cheap: DOES
// THE THING WE ARE ABOUT TO PUBLISH ACTUALLY DO IT? The release already unzips the
// packaged artifact, `npm install`s it and boots it against a scratch HOME. So this
// gate asks that boot.
//
// ── DOUBLE ENTRY, ON PURPOSE ──
// Two independent measurements, and both must be complete AND agree:
//
//   1. THE BOOT'S OWN REPORT — `GET /api/health` → `data.toolDocs`. This is the
//      runtime's own arithmetic, the same numbers the owner's Vitals card renders.
//   2. THE DIRECTORY — the `*.md` files actually sitting in the scratch HOME.
//
// A runtime that reports a complete set over an empty directory fails (2) and a
// directory somebody pre-seeded fails (1). Neither measurement alone can tell those
// apart, which is the whole reason there are two — and the directory the runtime
// NAMES is checked to be inside the scratch HOME, because a gate that counted the
// developer's own `~/.dojo/tools` would pass every time while measuring nothing
// about the artifact.
//
// ── THE VACUITY FLOOR ──
// `missing === 0` is satisfiable by `expected === 0`: a registry that failed to load
// owes nothing and writes nothing. So `expected` must clear a floor. It is a FLOOR
// and not a ratchet — the honest reading below it is "the tool registry emptied
// itself", not "the surface shrank" — so it does not rise as tools ship. Measured on
// a live box 2026-10-05: 443 manuals (`ls ~/.dojo/tools/*.md | wc -l`).
//
// ── OFFLINE, AND WHY THE SKIP IS SAFE ──
// Same shape and same reasoning as `check-upgrade-bypass.mjs` and
// `check-shipped-souls.mjs`. `npm run gates` has no booted artifact and no scratch
// HOME, so with neither this SKIPS LOUDLY and exits 0. A RELEASE cannot: it passes
// `--require-boot` and points this at the HOME its own smoke boot just wrote, so the
// build being SHIPPED is the thing that gets asked. A gate that quietly passes
// because it could not run is the exact false green this check exists to be.
//
// Usage:
//   node deploy/checks/check-shipped-tool-docs.mjs [smokeHome] [port] [--require-boot] [--verbose]
//     smokeHome  the sandbox HOME the artifact booted against (its `.dojo/tools` is read)
//     port       the port that boot is answering on
// Exit 0 = the boot wrote every manual it owed (or, offline, nothing to ask).
// Exit 1 = it did not, or it could not be asked when the caller said it must be.
// ════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const REQUIRE_BOOT = argv.includes('--require-boot');
const VERBOSE = argv.includes('--verbose');
const positional = argv.filter((a) => !a.startsWith('--'));

const HOME_ARG = positional.find((a) => !/^\d+$/.test(a)) ?? null;
const PORT_ARG = positional.find((a) => /^\d+$/.test(a)) ?? null;

// A FLOOR, not a ratchet. See the header.
const EXPECTED_FLOOR = 100;

let failed = false;
const fail = (...lines) => { failed = true; for (const l of lines) console.error(l); };

function skip(...lines) {
  if (REQUIRE_BOOT) {
    console.error('✗ shipped tool-docs: --require-boot was passed and the boot could not be asked.');
    for (const l of lines) console.error(`  ${l}`);
    console.error('  A release that could not ask the question must not answer it.');
    process.exit(1);
  }
  console.log('⚠ shipped tool-docs: the LIVE half SKIPPED — nothing booted to ask.');
  console.log('  (The contract half above ran and passed: the field names this gate reads are the ones');
  console.log('   `ToolDocsHealth` declares, so it has not gone blind while waiting for an artifact.)');
  for (const l of lines) console.log(`  ${l}`);
  console.log('  Correct for `npm run gates`, which has no packaged artifact and no sandbox HOME.');
  console.log('  The release passes --require-boot, which turns this skip into a failure.');
  process.exit(0);
}

// ════════ 0. THE CONTRACT — read out of the product, never re-typed here ════════
// Runs on EVERY invocation, before the skip, so `npm run gates` gets a real
// assertion out of this file rather than only a notice. It is the house rule the
// migration-freeze gate states out loud: a gate that re-typed the product's field
// names would report green while the boot was reporting a shape it no longer reads.
// Rename `written` in `ToolDocsHealth` and this reds here instead of going blind.
{
  const CONTRACT_REL = 'packages/shared/src/tool-docs-health.ts';
  // `fileURLToPath`, never `new URL(...).pathname`: the latter percent-encodes, and this
  // checkout's path contains a space. That exact idiom made every `gate-manifest --emit`
  // print nothing at the PHASE-3 T8G merge (see check-gate-manifest.mjs §4b).
  const CONTRACT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..', CONTRACT_REL);
  const READS = ['expected', 'written', 'missing', 'dir', 'lastError'];
  let src = null;
  try { src = fs.readFileSync(CONTRACT, 'utf8'); } catch { /* reported below */ }
  if (src === null) {
    fail(
      `✗ could not read ${CONTRACT_REL}, which declares the \`ToolDocsHealth\` shape this gate reads.`,
      '  Without it the field names below are a guess, and a guess that is wrong reports green.',
      '',
    );
  } else {
    const iface = /export interface ToolDocsHealth \{([\s\S]*?)\n\}/.exec(src);
    if (!iface) {
      fail(
        `✗ ${CONTRACT_REL} no longer declares \`export interface ToolDocsHealth { … }\`.`,
        '  This gate reads its field names from that declaration so the two cannot drift.',
        '',
      );
    } else {
      const declared = [...iface[1].matchAll(/^\s{2}(\w+)[?]?:/gm)].map((m) => m[1]);
      const absent = READS.filter((f) => !declared.includes(f));
      if (absent.length) {
        fail(
          `✗ this gate reads ${absent.length} field(s) that \`ToolDocsHealth\` no longer declares: ${absent.join(', ')}.`,
          `  Declared today: ${declared.join(', ')}`,
          '  A renamed field would make every clause below read `undefined`, and `undefined > 0` is',
          '  false — so the gate would pass a box that wrote nothing. Re-point the reads.',
          '',
        );
      } else if (VERBOSE) {
        console.log(`  contract: ToolDocsHealth declares ${declared.join(', ')} — all ${READS.length} reads present`);
      }
    }
  }
  if (failed) {
    console.error('✗ shipped tool-docs: refusing — the gate\'s own contract with the product is broken.');
    process.exit(1);
  }
}

if (!HOME_ARG && !PORT_ARG) {
  skip('No sandbox HOME and no port were given.');
}
if (!HOME_ARG) skip(`A port (${PORT_ARG}) was given but no sandbox HOME, so the directory half cannot be measured.`);
if (!PORT_ARG) skip(`A sandbox HOME (${HOME_ARG}) was given but no port, so the boot's own report cannot be read.`);

const TOOLS_DIR = path.join(HOME_ARG, '.dojo', 'tools');

// ════════ 1. the boot's own report ════════
let health;
try {
  const res = await fetch(`http://127.0.0.1:${PORT_ARG}/api/health`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) skip(`GET /api/health on :${PORT_ARG} answered HTTP ${res.status}.`);
  health = await res.json();
} catch (err) {
  skip(
    `Nothing answered GET /api/health on 127.0.0.1:${PORT_ARG}: ${String(err?.message ?? err).split('\n')[0]}`,
  );
}

const docs = health?.data?.toolDocs;
if (!docs || typeof docs !== 'object') {
  fail(
    `✗ the booted artifact's /api/health carries no \`data.toolDocs\`.`,
    '  That field is ABSENT (deliberately, not zeroed) until boot has measured the manual set —',
    '  "not asked yet" and "nothing missing" are different answers and only the second is good',
    '  news. An absent field here means the boot never reached the generator, or the recorder',
    '  stopped reporting, or `/api/health` stopped carrying it. Any of the three is a build that',
    '  cannot say whether it is serving its own manuals.',
    `  What /api/health did carry: ${Object.keys(health?.data ?? {}).join(', ') || '(nothing)'}`,
    '',
  );
} else {
  const { expected, written, missing, dir, lastError } = docs;

  if (!Number.isFinite(expected) || expected < EXPECTED_FLOOR) {
    fail(
      `✗ the boot reports it owed ${JSON.stringify(expected)} tool manual(s); the floor is ${EXPECTED_FLOOR}.`,
      '  `missing === 0` is satisfiable by `expected === 0`: a registry that failed to load owes',
      '  nothing and writes nothing, and every other clause here would then pass on vacuity.',
      '  This is a floor, not a ratchet — below it the honest reading is that the tool registry',
      '  emptied itself in the packaged build.',
      '',
    );
  }

  if (!Number.isFinite(missing) || missing > 0) {
    fail(
      `✗ the boot wrote ${written} of ${expected} tool manual(s) — ${missing} missing.`,
      `  Directory it wrote to: ${dir}`,
      lastError ? `  First failure it recorded: ${lastError}` : '  It recorded no write error, which makes this worse, not better.',
      '  An agent asking for one of those manuals gets whatever was on disk before — after an',
      '  upgrade that is the PREVIOUS version\'s instructions, and they read exactly like current',
      '  ones. Publishing a build whose own boot cannot write its manuals ships that silence to',
      '  every box.',
      '',
    );
  }

  if (lastError) {
    fail(
      `✗ the boot recorded a tool-manual write failure: ${lastError}`,
      '  Even with the count complete, a recorded failure means at least one write was retried',
      '  into place or the recorder is reporting a number it cannot stand behind.',
      '',
    );
  }

  // The directory the RUNTIME names must be the sandbox one. Without this the gate
  // could be counting the developer's own ~/.dojo/tools and would pass for ever.
  const named = typeof dir === 'string' ? path.resolve(dir) : '';
  const wanted = path.resolve(TOOLS_DIR);
  if (named !== wanted) {
    fail(
      '✗ the boot wrote its manuals somewhere other than the sandbox HOME this gate was given.',
      `    the boot names : ${named || JSON.stringify(dir)}`,
      `    this gate reads: ${wanted}`,
      '  Both halves of the measurement have to be about the same directory, or a green here is',
      '  a statement about a directory nobody shipped — the developer\'s own ~/.dojo/tools, for',
      '  instance, which would pass every single time.',
      '',
    );
  }

  // ════════ 2. the directory, counted independently ════════
  let onDisk = null;
  try {
    onDisk = fs.readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.md'));
  } catch (err) {
    fail(
      `✗ could not read ${TOOLS_DIR}: ${String(err?.message ?? err).split('\n')[0]}`,
      '  The boot reported numbers about this directory. If it cannot be read, the report is the',
      '  only witness to its own claim — which is the shape of the original defect.',
      '',
    );
  }

  if (onDisk !== null) {
    if (Number.isFinite(expected) && onDisk.length < expected) {
      fail(
        `✗ the boot reports ${written}/${expected} manuals written, but ${TOOLS_DIR} holds ${onDisk.length} \`.md\` file(s).`,
        '  The runtime\'s arithmetic and the filesystem disagree. Double entry exists for exactly',
        '  this: a report of a complete set over an incomplete directory is the failure mode the',
        '  original defect had (count-only, never compared), one layer up.',
        '',
      );
    }
    if (VERBOSE) {
      console.log(`  (directory sample: ${onDisk.slice(0, 5).join(', ')}${onDisk.length > 5 ? ', …' : ''})`);
    }
  }

  if (!failed) {
    console.log(
      `✓ shipped tool docs — the booted artifact wrote all ${expected} manual(s) it owed; `
      + `${onDisk.length} \`.md\` file(s) counted independently in the sandbox HOME`,
    );
    console.log(`  asked: GET http://127.0.0.1:${PORT_ARG}/api/health → data.toolDocs`);
    console.log(`  read:  ${TOOLS_DIR}`);
  }
}

if (failed) {
  console.error('✗ shipped tool-docs: refusing.');
  process.exit(1);
}
process.exit(0);
