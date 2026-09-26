// ════════════════════════════════════════════════════════════════════════════════════════
// THE REPORT TOOL CANNOT POST (DOJO-REPORT T3).
//
// Owner ruling D4 — "the consent gate is absolute" — is enforced in three different places
// and this file holds the FIRST of them, which is the only one that is structural rather
// than behavioural: the agent-facing tool has no phase that sends, no import that reaches
// GitHub, and no reference to either door that consumes an approval. T2's store holds the
// second (`approveOnce` is one-shot) and T6's card holds the third (a human presses it).
//
// A structural claim needs a structural proof, so the middle clause reads the handler's OWN
// SOURCE. That is deliberately not a grep standing in for a behavioural test — there IS no
// behaviour to observe here, because the property is the ABSENCE of a code path, and the
// only honest way to assert an absence is to look. The behavioural half lives next door in
// `the-agents-words-never-reach-the-telemetry.test.ts`, where the tool is actually driven.
//
// The first block is the default-grant claim (D5): `dojo_report` joins the existing 'Meta'
// category, which `MOST_RESTRICTIVE_GRANTS` already carries, so every agent holds it at
// creation with no new label, no `access.ts` change and no backfill migration. The
// always-loaded clause is the cache-prefix law (roadmap non-negotiable #10) written as a
// test: this tool's schema must ride `load_tool_docs` and must never widen the cached head.
//
// ── THE FILE NOW HOLDS TWO INSTRUCTION PINS OVER ONE SHIPPED STRING (T8, 2026-09-26) ────
// It is named for the first property it carried, and that name is still true. What it is
// FOR is the shipped `dojo_report` description — the only copy of that text that reaches
// production — and it now pins two independent things in it: the PRIVACY rule (FR-2, below)
// and the TRIGGER (T8, at the bottom). They live in one file on purpose. Both are anchored
// on sentences inside the same string, so whoever rewords that string meets both lists in
// one place instead of updating one and silently dropping the other. There is ONE mechanism
// here — a table of (why, sentence) pairs checked in a loop — used twice, not two.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { toolDefinitions } from '../definitions.js';
import { handlerFor } from '../handlers.js';
import { TOOL_CATEGORIES } from '../../../tools/categories.js';
import { MOST_RESTRICTIVE_GRANTS } from '@dojo/shared';

const DEF = toolDefinitions.find(d => d.name === 'dojo_report');

const handlerSrc = (): string =>
  fs.readFileSync(path.join(__dirname, '..', 'cat', 'report.ts'), 'utf8');

describe('the tool exists, is default-granted, and rides load_tool_docs', () => {
  it('is declared, has a handler, and is last in the array (append-only)', () => {
    expect(DEF).toBeDefined();
    expect(handlerFor('dojo_report')).toBeTypeOf('function');
    expect(toolDefinitions[toolDefinitions.length - 1].name).toBe('dojo_report');
  });

  it('sits in a category every agent already holds, so it needs no new grant', () => {
    const labels = TOOL_CATEGORIES.filter(c => c.tools.includes('dojo_report')).map(c => c.label);
    expect(labels).toEqual(['Meta']);
    expect(MOST_RESTRICTIVE_GRANTS.tools.categories).toContain('Meta');
  });

  it('is NOT always-loaded — its schema must not widen every agent cached prefix', async () => {
    const { DEFAULT_ALWAYS_LOADED_TOOLS } = await import('../../../tools/tool-docs.js');
    expect(DEFAULT_ALWAYS_LOADED_TOOLS).not.toContain('dojo_report');
  });

  it('declares no key inside input_schema beyond JSON Schema', () => {
    const keys = Object.keys(DEF!.input_schema);
    expect(keys.sort()).toEqual(['properties', 'required', 'type']);
  });
});

describe('the tool cannot post, structurally', () => {
  it('offers no phase that sends anything', () => {
    const phases = (DEF!.input_schema.properties as Record<string, { enum?: string[] }>).phase.enum;
    expect(phases).toEqual(['gather', 'draft', 'submit']);
    expect(phases).not.toContain('post');
  });

  it('reaches no github module and no approval door from its handler', () => {
    const src = handlerSrc();
    for (const forbidden of ['/github/', 'api.github.com', 'approveOnce', 'markPosted', 'postApprovedReport']) {
      expect(src.includes(forbidden), `cat/report.ts references ${forbidden}`).toBe(false);
    }
  });

  it('tells the agent in its own description that it cannot send', () => {
    expect(DEF!.description).toContain('YOU CANNOT SEND ANYTHING');
  });

  // ⚠ THE PRIVACY INSTRUCTION IS LOAD-BEARING CODE, NOT PROSE (final review, FR-2).
  //
  // Privacy hard rule 1 — the brief must not carry quotes, user content, names, file contents
  // or credentials — has three enforcement legs, and this is the only clause over the first.
  // Leg (b), the mechanical scrub, sits UPSTREAM of the agent: it cleans what `gather` shows
  // it. That is the stronger placement, and it is also the reason this clause exists — with
  // the scrub before the agent rather than at the exit, NOTHING MECHANICAL STANDS BETWEEN THE
  // BRIEF AND THE PUBLIC PAGE. The instruction below and the owner's preview card are the
  // whole of the protection, so the instruction is a shipped safeguard and is pinned like one.
  //
  // Measured before it was written: the final reviewer deleted this entire paragraph from the
  // shipped description and the full suite SURVIVED. The only assertion over the description
  // anywhere in the tree was the "YOU CANNOT SEND ANYTHING" clause above, and
  // `registry-order.test.ts` compares the registry projection against the source projection,
  // so both sides move together and it pins nothing about content.
  //
  // BYTE-ANCHORED ON THE SENTENCES THAT MATTER, not on the paragraph's shape: a prompt-tuning
  // pass may reflow, reorder or re-word around these, and must not be able to drop any of them
  // without being told what it is dropping. The phases guide at `tools/docs/dojo_report.md`
  // carries the same rule at more length and is deliberately NOT asserted here — measured, it
  // never reaches the packaged build (`build-package.sh` copies migrations and templates only),
  // so it is documentation. The description is compiled code and reaches production.
  it('carries the MAY-NOT-CONTAIN rule into production, because the description IS the safeguard', () => {
    const LOAD_BEARING: readonly [string, string][] = [
      ['the rule is addressed to the brief', 'WHAT YOUR BRIEF MAY CONTAIN'],
      ['...and says WHY, which is the part that generalises', 'because this becomes a PUBLIC page'],
      ['no conversation quotes', 'quotes from the conversation'],
      ['nothing the user wrote', 'anything the user wrote'],
      ['no names, no addresses', 'anyone\'s name or address'],
      ['no file contents', 'file contents'],
      ['no file paths', 'file paths'],
      ['no credentials', 'credentials'],
      ['the positive instruction that makes the refusals actionable', 'Describe the SHAPE'],
      ['...and its complement', 'never the content'],
      ['the attachment is not the agent\'s to write', 'cannot add to it'],
    ];
    for (const [why, sentence] of LOAD_BEARING) {
      expect(
        DEF!.description,
        `the shipped tool description no longer says: ${sentence} (${why}). This paragraph is `
        + 'the ONLY thing standing between the agent and a public page besides the owner\'s own '
        + 'eyes — the scrubber runs upstream of the agent, not at the exit. If it is being '
        + 'reworded, keep every sentence above and update this list deliberately.',
      ).toContain(sentence);
    }
  });

  // ── T3 ADDITIONS, REWORDED IN FIX ROUND 1 ─────────────────────────────────────────────
  // These clauses read ONE FILE'S OWN TEXT, and after review that is exactly what they now
  // claim. The first wording — "imports nothing that could carry a report off the box" — was
  // false about the graph: the reviewer added a posting module under an unlisted name, called
  // it from `submit`, performed a real outbound POST, and every clause in this file stayed
  // green. A one-hop name scan cannot see 526 modules. The graph is measured next door in
  // `the-report-tool-reaches-no-new-door.test.ts`, which is the guard that refuses that
  // demonstration; these two remain because a file that names a host or calls `fetch` itself
  // is worth catching at the cheapest possible altitude, and because they say what they do.

  it('names no outbound module in its OWN import list (one hop — the graph is censused next door)', () => {
    const imports = [...handlerSrc().matchAll(/from\s+'([^']+)'/g)].map(m => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect(spec, `cat/report.ts imports ${spec}`).not.toMatch(/github/i);
      // `node:https`, `undici`, a fetch wrapper — anything whose whole job is leaving.
      expect(spec, `cat/report.ts imports ${spec}`).not.toMatch(/^node:(https?|net|tls|dgram)$/);
    }
  });

  it('never names fetch IN ITS OWN BODY, so the cheapest way out is not open here', () => {
    // `writeBundle`/`writeReportFile` write to `~/.dojo`; `broadcast` reaches a local socket.
    // This does NOT prove the closure holds no `fetch` — 37 modules in it do. That is prong C
    // of the census next door, which pins them by name so a NEW one fails the build.
    expect(handlerSrc()).not.toMatch(/\bfetch\s*\(/);
  });

  it('declares one effect and it is the LOCAL bundle, not a network send', () => {
    expect(DEF!.effects).toEqual([
      { kind: 'fs_write', from: 'fixed:the local report bundle under ~/.dojo/reports' },
    ]);
    expect(DEF!.effects.some(e => e.kind === 'net' || e.kind === 'send')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// ⚠ THE TRIGGER IS LOAD-BEARING TOO (T8, 2026-09-26, the owner watching).
//
// THE MEASURED DEFECT. A staged agent was handed the owner's own designed phrase — "That
// wasn't right. Why did that happen? Let's get this fixed in the Dojo." — and did NOT reach
// for `dojo_report`. It investigated its own grants, delegated to another agent to ask for a
// permission, was correctly refused, and burned the whole loop until a human said "file this
// as a problem report about the platform." Pointed at the tool it then ran gather → draft →
// submit perfectly. So nothing in T1-T7's machinery was wrong; the RECOGNITION was, and the
// recognition lives entirely in the wording the agent reads. That makes the cues and the
// discriminator below the same class of thing as FR-2's privacy paragraph: shipped text
// doing a job no other code does, therefore pinned.
//
// SAME MECHANISM AS FR-2, DELIBERATELY — a table of (why, sentence) pairs checked in a loop,
// byte-anchored on the sentences that carry the load and nothing else. A prompt-tuning pass
// may reflow, reorder or re-word around them; it may not drop one without being told which.
//
// WHY THE .md IS ASSERTED HERE WHEN FR-2 REFUSED TO ASSERT IT. FR-2's reason was measured
// and still holds: `packages/server/src/tools/docs/*.md` never reaches the packaged build
// (`deploy/build-package.sh` copies `dist` + migrations + templates only, and `tsc` does not
// emit .md, so `dist/tools/docs/` does not exist — verified on both the local dist and
// `deploy/dist/.../server/dist/tools/`). In PRODUCTION `load_tool_docs('dojo_report')`
// therefore returns `formatToolDoc(def)`, i.e. THE DESCRIPTION. But on the DEV BOX the
// server runs `tsx watch src/index.ts`, so `index-generator.ts`'s override path resolves
// inside `src/` and the .md IS copied verbatim into `~/.dojo/tools/dojo_report.md` (verified
// by diff on the live box: byte-identical to the source file). Every behavioural run —
// including the T8 run this clause exists because of — reads the .md. If a cue lives in one
// surface and not the other, the live proof stops testing what ships. So the TRIGGER
// sentences are required in BOTH; the privacy paragraph's placement is unchanged.
// ════════════════════════════════════════════════════════════════════════════════════════
const overrideDoc = (): string =>
  fs.readFileSync(path.join(__dirname, '..', '..', '..', 'tools', 'docs', 'dojo_report.md'), 'utf8');

// The recognition cues. The owner's instruction, verbatim: "a user might say 'Can we let
// DOJO know about this?' or 'Can we get that fixed?' or 'Report this problem' or many other
// ways to say it." The three owner phrasings plus the family, and — the part that makes it a
// trigger rather than a matcher — the sentences that say out loud the list is not exhaustive.
const TRIGGER_CUES: readonly [string, string][] = [
  ['what it is, in the user\'s own terms, first', 'THE PEOPLE WHO BUILD THE DOJO TO KNOW ABOUT A PROBLEM WITH THE DOJO ITSELF'],
  ['...and that no other tool does it', 'it is the only tool that does it'],
  ['the cue instruction itself', 'REACH FOR IT WHEN THE USER'],
  ['the list is OPEN-ENDED and says so', 'EXAMPLES, NOT A PATTERN TO MATCH'],
  ['...and says so a second time, after the list', 'The list does not end there and is not meant to'],
  ['the owner\'s own designed phrase, the one the live run missed', 'let\'s get this fixed in the Dojo'],
  ['owner phrasing 2', 'can we let DOJO know about this?'],
  ['owner phrasing 3', 'can we get that fixed?'],
  ['owner phrasing 4', 'report this problem'],
  ['the family: the devs', 'tell the Dojo devs'],
  ['the family: report', 'can we report this'],
  ['the family: bug', 'submit a bug'],
  ['the family: broken', 'let them know this is broken'],
  ['the family: issue', 'file an issue'],
  ['the family: platform', 'this is a platform problem'],
  ['SENSE over phrase — the instruction that generalises past the list', 'if the SENSE of what they said is'],
  ['...stated as a prohibition too, because a floor model waits for the magic word', 'Do not wait for a particular phrase'],
];

// The discriminator. Every clause below names a branch the live run actually took.
const TRIGGER_DISCRIMINATOR: readonly [string, string][] = [
  ['the discriminator, as a heading the model cannot skim past', 'THIS IS ABOUT THE PLATFORM, NOT ABOUT YOUR SITUATION'],
  ['what the platform IS, so "platform" is not an abstraction', 'the engine, the tools, the dashboard'],
  ['the wrong branches are named as wrong', 'THE WRONG BRANCHES'],
  ['...branch 1 of the live run: it investigated its own grants', 'investigating your own grants or permissions'],
  ['...branch 2 of the live run: it delegated to a peer to ask for a permission', 'delegating to another agent or asking a peer for help'],
  ['...and the near-miss branch: fixing the situation instead of reporting it', 'fixing the user\'s immediate situation instead of reporting it'],
  ['the positive resolution, so the paragraph is not purely a list of refusals', 'none of those is the answer and this tool is'],
  ['the grant fact that kills the permission hunt at the root (D5)', 'there is nothing to request and nobody to ask'],
];

// The ambiguity door (the owner's own suggestion: "perhaps the agent needs a way to ask if
// that's what the user is asking for if the agent is unclear"). OR2 keeps this in the
// WORDING and out of the engine: no gate reads the user's words and routes them here.
const AMBIGUITY_DOOR: readonly [string, string][] = [
  ['the door is opened explicitly, and closed again with "then act"', 'IF YOU ARE NOT SURE THAT IS WHAT THEY MEANT, ASK'],
  ['the exact question is MODELLED, not described', 'Do you want me to file this as a problem report to the Dojo\'s developers?'],
  ['asking is cheap', 'Asking costs one sentence'],
  ['...and a wrong silent branch is expensive, which is the asymmetry that decides it', 'Guessing silently costs the whole turn'],
  ['one question, then act — never a loop of clarifications', 'Ask once, take the answer, act on it'],
  ['...and not a shield for stalling on words that are already plain', 'do not ask at all when their words already say it plainly'],
];

describe('the agent can tell that the user just asked for THIS tool (T8)', () => {
  const surfaces = (): [string, string][] => [
    ['the shipped tool description (definitions.ts — the only copy production reads)', DEF!.description],
    ['the dev-box override doc (tools/docs/dojo_report.md — what every behavioural run reads)', overrideDoc()],
  ];

  it('leads with what the user wants and carries the OPEN-ENDED cue list, on both surfaces', () => {
    for (const [surface, text] of surfaces()) {
      for (const [why, sentence] of TRIGGER_CUES) {
        expect(
          text,
          `${surface} no longer says: ${sentence} (${why}). T8 measured a staged agent missing this `
          + 'tool on the owner\'s own phrase; these sentences are the fix and there is no other '
          + 'mechanism behind them — the tool index in the system prompt lists the NAME only. If '
          + 'the wording is being revised, keep every sentence and update this list deliberately.',
        ).toContain(sentence);
      }
    }
  });

  it('names the wrong branches the live run actually took, on both surfaces', () => {
    for (const [surface, text] of surfaces()) {
      for (const [why, sentence] of TRIGGER_DISCRIMINATOR) {
        expect(
          text,
          `${surface} no longer says: ${sentence} (${why}). This is the discriminator that would `
          + 'have saved the T8 run: the tool is for a problem with the PLATFORM, and a grant hunt '
          + 'or a hand-off to a peer is the wrong branch when the user\'s words point at reporting.',
        ).toContain(sentence);
      }
    }
  });

  it('offers the one-line clarifying question rather than a silent guess, on both surfaces', () => {
    for (const [surface, text] of surfaces()) {
      for (const [why, sentence] of AMBIGUITY_DOOR) {
        expect(
          text,
          `${surface} no longer says: ${sentence} (${why}). The ambiguity door is the owner\'s own `
          + 'suggestion and it is guidance, not machinery: OR2 keeps the engine out of judging what '
          + 'the user meant, so if this sentence goes, nothing else asks.',
        ).toContain(sentence);
      }
    }
  });

  it('keeps the trigger BEHIND the cache breakpoint: the description may grow, the prefix may not', () => {
    // The cue rewrite adds ~1.4 KB to a description that is already 1.9 KB. That is only
    // affordable because this tool is not always-loaded (clause above), so the bytes ride the
    // session-loaded tail behind `cacheBreakpointIndex` and cost only an agent that asks.
    // The tool INDEX line in the cached system prefix is names-only (`tools/categories.ts`
    // renders `\`name\`` and nothing else), so no amount of description text can move it.
    expect(DEF!.description.length).toBeGreaterThan(2000);
    for (const name of ['dojo_report']) {
      expect(TOOL_CATEGORIES.find(c => c.tools.includes(name))!.label).toBe('Meta');
    }
  });
});
