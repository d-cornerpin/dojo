// ════════════════════════════════════════════════════════════════════════════════════════
// T85 — A HAND-WRITTEN MANUAL MUST NAME EXACTLY THE PARAMETERS ITS TOOL TAKES.
//
// ── THE DEFECT THIS EXISTS FOR, MEASURED ──
// `packages/server/src/tools/docs/<tool>.md` is a hand-written OVERRIDE: when the file exists,
// `tools/index-generator.ts:96-99` copies it VERBATIM into `~/.dojo/tools/<tool>.md` instead of
// generating one from the live definition. That is the whole point of the mechanism (a manual can
// carry a prompting guide a `description` field cannot) and it is also its one hazard: the
// generated doc tracks the schema for free, and the override does not track anything at all.
//
// `image_create` gained a `title` parameter — the string that becomes the file name the user
// downloads — and `image_create.md` was last edited in April. For ~5 months every agent that
// called `load_tool_docs('image_create')` read a manual that did not know the parameter existed,
// so the file names users got were generic ids. Nothing failed. There was no reader anywhere that
// compared the two.
//
// This is that reader. It is a TRIPWIRE for the class, not a check of one file: any manual whose
// `## Parameters` list drifts from its tool's `input_schema` fails here, in BOTH directions —
// a schema property the manual never mentions (the `title` case) and a manual bullet the schema
// no longer has (the retired-parameter case, which teaches a model to send an argument that is
// rejected at the boundary).
//
// ── WHY A MANUAL WITHOUT A `## Parameters` SECTION IS NOT EXEMPT ──
// `dojo_report.md` deliberately documents its arguments phase by phase in prose rather than in one
// list, and forcing it into a bullet list would make the manual worse. So the section is optional
// and the COVERAGE is not: a manual with no `## Parameters` section must still name every schema
// property literally somewhere in its text. HONEST BOUND, recorded here rather than only in a
// report: for those manuals the reverse direction is not enforced, because a bare word in prose
// ("title", "lane") cannot be distinguished from a parameter reference. A manual that wants the
// exact, two-way assertion writes the section.
//
// ── AND THE GHOST CLASS, CLOSED FROM THE SOURCE SIDE ──
// `generateToolDocs` writes a file for every name in `registryToolDefinitions()` and consults the
// override INSIDE that loop, so a manual whose name is not a registered tool is never read, never
// written, and can never reach a model — while shipping, passing the packaging assert, and reading
// like documentation. `image_generate_internal.md` was exactly that for months (deleted at T85).
// The first clause below is what stops the next one being born.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAllToolDefinitions } from '../../agent/tools/definitions.js';
import type { ToolDefinition } from '../../agent/tools/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The directory `tools/index-generator.ts` resolves its overrides from (`./docs`, one hop off
 *  its own module location — `src/tools/docs` here, `dist/tools/docs` in a packaged install). */
const DOCS_DIR = path.resolve(HERE, '../docs');

const MANUALS = fs.readdirSync(DOCS_DIR).filter((f) => f.endsWith('.md')).sort();

const defsByName = new Map<string, ToolDefinition>(
  getAllToolDefinitions().map((d) => [d.name, d] as const),
);

/**
 * The parameter names a manual CLAIMS, read out of its `## Parameters` section.
 *
 * Returns `null` when the manual has no such section — which is a different fact from "the
 * section is there and empty", and the clauses below treat it as one.
 *
 * The bullet shape is `formatToolDoc`'s own (`index-generator.ts:54`): `- **name** (type, req)`.
 * Reading the same shape the generator writes is deliberate — a manual is a replacement for that
 * output, so the two must be legible to one reader.
 */
function declaredParams(markdown: string): string[] | null {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => /^##\s+Parameters\s*$/.test(l.trim()));
  if (start === -1) return null;
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;                       // next section ends the list
    const m = /^\s*[-*]\s+\*\*`?([A-Za-z0-9_]+)`?\*\*/.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

const schemaParams = (def: ToolDefinition): string[] =>
  Object.keys((def.input_schema.properties ?? {}) as Record<string, unknown>);

// ════════════════════════════════════════════════════════════════════════
// 0 — NON-VACUITY. A reader that finds nothing to read reports a clean sweep.
// ════════════════════════════════════════════════════════════════════════

describe('T85 — the manual/schema reader is reading something', () => {
  it('the override directory ships manuals, and this test found them', () => {
    expect(MANUALS.length, `no *.md in ${DOCS_DIR} — either the override directory moved (and this `
      + 'tripwire now proves nothing) or every manual was deleted. Both are findings.').toBeGreaterThan(0);
  });

  it('at least one manual carries a `## Parameters` section — the two-way clause has a subject', () => {
    const withSection = MANUALS.filter((f) => declaredParams(fs.readFileSync(path.join(DOCS_DIR, f), 'utf8')) !== null);
    expect(withSection.length, 'no manual has a `## Parameters` section, so the exact-match clause '
      + 'below would pass by having nothing to compare').toBeGreaterThan(0);
  });

  it('CONTROL: the bullet parser bites on a planted drift', () => {
    // Ships with the clause and runs on every invocation, so "this parser can actually see a
    // missing parameter" is a fact this file proves about itself rather than something someone
    // checked once. Same practice as the gate selftests in deploy/checks.
    const complete = '# t\n\nbody\n\n## Parameters\n\n- **description** (string, required): x\n'
      + '- **title** (string, optional): y\n\n## Next\n\n- **not_a_param** (string): ignored\n';
    expect(declaredParams(complete)).toEqual(['description', 'title']);
    // the `title` case, planted
    const drifted = complete.replace('- **title** (string, optional): y\n', '');
    expect(declaredParams(drifted)).toEqual(['description']);
    expect(declaredParams(drifted)).not.toEqual(declaredParams(complete));
    // a manual with no section at all is `null`, not `[]`
    expect(declaredParams('# t\n\nbody only\n')).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// 1 — THE GHOST CLASS: a manual for a name that is not a tool can never be served.
// ════════════════════════════════════════════════════════════════════════

describe('T85 — every hand-written manual names a registered tool', () => {
  it.each(MANUALS)('%s shadows a real tool definition', (file) => {
    const toolName = file.slice(0, -'.md'.length);
    expect(
      defsByName.has(toolName),
      `${file} names "${toolName}", which is not a registered tool. `
      + '`generateToolDocs` iterates `registryToolDefinitions()` and looks for the override INSIDE '
      + 'that loop, so this file is never read, never written to ~/.dojo/tools, and can never reach '
      + 'a model — and `load_tool_docs` intersects every requested name with `getFilteredTools` '
      + 'before reading anything, which is a second lock on the same door. Either the tool was '
      + 'renamed (rename the manual in the same commit) or the manual outlived its tool (delete it, '
      + 'and its line in check-shipped-souls.mjs\'s REQUIRED_TOOL_MANUALS).',
    ).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2 — THE DRIFT TRIPWIRE, BOTH DIRECTIONS.
// ════════════════════════════════════════════════════════════════════════

describe('T85 — a manual\'s `## Parameters` names exactly the tool\'s input_schema properties', () => {
  const withSchema = MANUALS
    .map((file) => ({ file, def: defsByName.get(file.slice(0, -'.md'.length)) }))
    .filter((r): r is { file: string; def: ToolDefinition } => r.def !== undefined);

  it.each(withSchema.map((r) => r.file))('%s', (file) => {
    const def = defsByName.get(file.slice(0, -'.md'.length)) as ToolDefinition;
    const markdown = fs.readFileSync(path.join(DOCS_DIR, file), 'utf8');
    const declared = declaredParams(markdown);
    const schema = schemaParams(def);

    if (declared === null) {
      // No `## Parameters` section: coverage is still owed, one direction (see the header).
      const unnamed = schema.filter((p) => !markdown.includes(p));
      expect(
        unnamed,
        `${file} has no \`## Parameters\` section and never names ${unnamed.join(', ')}. `
        + `The tool takes ${schema.length} parameter(s) and an agent reads this file INSTEAD of the `
        + 'generated doc, so a parameter this manual is silent about is one the model will not send. '
        + 'Either name it in the prose or give the manual a `## Parameters` section.',
      ).toEqual([]);
      return;
    }

    const missingFromManual = schema.filter((p) => !declared.includes(p));
    const absentFromSchema = declared.filter((p) => !schema.includes(p));

    expect(
      missingFromManual,
      `${file} does not document ${missingFromManual.join(', ')} — the tool takes it and the manual `
      + 'replaces the generated doc entirely, so no agent will ever learn the parameter exists. '
      + `(This is the measured \`image_create\`/\`title\` defect: 5 months, no failure.) Schema: `
      + `${schema.join(', ')}.`,
    ).toEqual([]);

    expect(
      absentFromSchema,
      `${file} documents ${absentFromSchema.join(', ')}, which the tool's input_schema does not `
      + 'have. A model that believes the manual sends an argument the boundary rejects. Either the '
      + `parameter was renamed or removed in the code; the manual owes the same edit. Schema: `
      + `${schema.join(', ')}.`,
    ).toEqual([]);
  });
});
