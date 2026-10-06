// ════════════════════════════════════════════════════════════════════════════════════════
// NO SHIPPED TEMPLATE WITHOUT A READER — t107 (t92's find: `templates/SOUL.md` had none).
//
// ── WHAT WAS MEASURED, AND WHY AN ORPHAN IS WORSE THAN A MISSING FILE ──
// `deploy/build-package.sh:144-145` copies `templates/*.md` into every artifact, so anything in
// that directory ships to every box and reads like doctrine. `templates/SOUL.md` shipped 2,509
// bytes of PRIMARY-agent doctrine that reached NO MODEL ANYWHERE: the primary's soul is seeded
// from the in-code `DEFAULT_SOUL_MD` (`assembler.ts`'s `readPromptFile('SOUL.md', …)`), and a
// box that completes setup gets a THIRD text generated from the OOBE form
// (`gateway/routes/config.ts`). Its content was not a stale copy of the default either — other
// headings, other rules, a `# Rules` section the default does not have. A second opinion with
// no reader is the worst of the three: it is the file a maintainer edits believing they changed
// what an agent reads.
//
// So the directory is now closed: every file in it is either RESOLVED by a production reader or
// a DECLARED MIRROR of an in-code default, pinned byte-for-byte by a named clause.
//
// ── WHY THE READERS ARE DISCOVERED AND THE DOORS ARE CLOSED (G4) ──
// A presence-only census ("each file is mentioned somewhere") would pass on `'SOUL.md'`, which
// appears all over the tree as the name of the PER-BOX file in `~/.dojo/prompts` — a different
// file entirely. What makes a file a SHIPPED template is being resolved through one of the two
// doors that reach the `templates/` directory, so this census enumerates THE DOORS and the
// names each requests, and refuses a third door it has not been told about. That is the
// direction a presence clause cannot cover: a new door added without registering it REDS here
// rather than quietly widening the corpus.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const TEMPLATES = path.join(REPO_ROOT, 'templates');
const SERVER_SRC = path.join(REPO_ROOT, 'packages/server/src');

/**
 * The two production files allowed to reach the shipped templates directory, and the job each
 * does with it. A third one must be added here with its reason — which is the point.
 */
const DOORS: ReadonlyArray<{ readonly file: string; readonly job: string }> = [
  { file: 'prompt/assembler.ts', job: 'platformTemplateSearchPaths / readPlatformTemplate — the seeding door for every file-backed soul' },
  { file: 'vault/maintenance.ts', job: 'the Dreamer identity refresh, which re-reads its template on every boot check' },
];

/**
 * A file that ships with no reader BY DESIGN: a byte-identical mirror of an in-code default,
 * kept so the installed `templates/` directory does not contradict the engine. Each entry names
 * the constant it mirrors and the clause that pins the two together, and this census checks
 * BOTH of those claims rather than trusting the declaration.
 */
const DECLARED_MIRRORS: ReadonlyArray<{
  readonly file: string; readonly constant: string; readonly pinnedBy: string;
}> = [
  {
    file: 'USER.md',
    constant: 'DEFAULT_USER_MD',
    pinnedBy: 'prompt/__tests__/the-profile-admits-it-is-empty.test.ts',
  },
];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function productionSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p); continue; }
      if (e.name.endsWith('.ts') && !/\.(?:test|spec)\.ts$/.test(e.name)) out.push(p);
    }
  };
  walk(SERVER_SRC);
  return out;
}

/**
 * A path literal that resolves into the SHIPPED templates directory — the two shapes the
 * resolvers actually use, and no third:
 *
 *   · an UPWARD hop out of the module's own directory, `'../../../../templates[/<name>]'`
 *     (`platformTemplateSearchPaths`'s repo and packaged layouts, and the Dreamer's resolve);
 *   · the lone segment `'templates'`, joined onto `~/.dojo/platform` (the installed layout).
 *
 * The anchoring is load-bearing, not tidiness: `agent/tools/definitions.ts` describes a
 * TECHNIQUE directory's own `"templates/brief.md"` in a tool schema, which is a different
 * directory on a different disk path, and a looser pattern counted it as a door and `brief.md`
 * as a shipped template that had gone missing.
 */
const TEMPLATES_PATH_LITERAL = /['"]((?:\.\.\/)+[^'"]*templates(?:\/[A-Za-z0-9._-]+)?|templates)['"]/g;

/** Every production file whose source (comments stripped) resolves a path into `templates/`. */
function filesReachingTheTemplatesDir(): string[] {
  const hits: string[] = [];
  for (const file of productionSources()) {
    const src = stripComments(fs.readFileSync(file, 'utf-8'));
    if (new RegExp(TEMPLATES_PATH_LITERAL.source).test(src)) hits.push(path.relative(SERVER_SRC, file));
  }
  return hits.sort();
}

/**
 * The template basenames production actually asks for.
 *
 *  · `shippedSoulDefaultFrom('<NAME>', …)` — the one helper every file-backed soul's seed goes
 *    through, so the four names it is called with are the four the assembler requests.
 *  · a literal `templates/<NAME>` path — the Dreamer's direct resolve.
 */
function requestedNames(): Set<string> {
  const names = new Set<string>();
  for (const file of productionSources()) {
    const src = stripComments(fs.readFileSync(file, 'utf-8'));
    for (const m of src.matchAll(/shippedSoulDefaultFrom\(\s*'([^']+\.md)'/g)) names.add(m[1]);
    for (const m of src.matchAll(new RegExp(TEMPLATES_PATH_LITERAL.source, 'g'))) {
      const leaf = m[1].split('/').pop()!;
      if (leaf.endsWith('.md')) names.add(leaf);
    }
  }
  return names;
}

/** The predicate itself, pure over its inputs so the controls below can drive it. */
function orphansAmong(files: readonly string[], requested: ReadonlySet<string>): string[] {
  const mirrored = new Set(DECLARED_MIRRORS.map(m => m.file));
  return files.filter(f => !requested.has(f) && !mirrored.has(f)).sort();
}

const shipped = fs.readdirSync(TEMPLATES).filter(f => f.endsWith('.md')).sort();

describe('every file the platform ships in templates/ is read, or is a declared mirror', () => {
  it('the census found something to census — an empty corpus is not a clean sweep', () => {
    expect(shipped.length).toBeGreaterThan(0);
    expect(requestedNames().size).toBeGreaterThan(0);
  });

  it('⚠ no shipped template is reader-less', () => {
    expect(orphansAmong(shipped, requestedNames())).toEqual([]);
  });

  it('every name production asks for is a file that actually ships', () => {
    // The other direction of the same question: a reader pointed at a template nobody ships
    // falls back to an in-code stub, silently, on every box (that is W24/W25's defect).
    expect([...requestedNames()].filter(n => !shipped.includes(n)).sort()).toEqual([]);
  });

  it('the doors into templates/ are the declared ones, and no others', () => {
    expect(filesReachingTheTemplatesDir()).toEqual(DOORS.map(d => d.file).sort());
  });

  it('every declared mirror really is byte-identical to the constant it names', async () => {
    const templates = await import('../templates.js') as Record<string, unknown>;
    for (const m of DECLARED_MIRRORS) {
      const value = templates[m.constant];
      expect(typeof value, `${m.constant} is exported from prompt/templates.ts`).toBe('string');
      expect(fs.readFileSync(path.join(TEMPLATES, m.file), 'utf-8')).toBe(value);
      // The declaration's second claim: the clause it points at exists and names this file.
      const pinned = path.join(SERVER_SRC, m.pinnedBy);
      expect(fs.existsSync(pinned), `${m.pinnedBy} exists`).toBe(true);
      expect(fs.readFileSync(pinned, 'utf-8')).toContain(m.file);
    }
  });

  it('⚠ CONTROLS — the predicate refuses what it is here to refuse, and accepts what it should', () => {
    const requested = requestedNames();
    // The lists here are WRITTEN OUT rather than derived from `shipped`, so a control cannot
    // change its verdict because the directory changed — a control that moves with the corpus
    // it is checking proves nothing about the predicate.
    //
    // An undeclared newcomer is an orphan, and a read sibling does not rescue it…
    expect(orphansAmong(['PM-SOUL.md', 'NOBODY-READS-ME.md'], requested)).toEqual(['NOBODY-READS-ME.md']);
    // …a declared mirror is not an orphan…
    expect(orphansAmong(DECLARED_MIRRORS.map(m => m.file), requested)).toEqual([]);
    // …and the rule does not simply refuse everything.
    expect(orphansAmong(['PM-SOUL.md', 'DREAMER-SOUL.md', 'USER.md'], requested)).toEqual([]);
  });
});
