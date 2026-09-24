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
