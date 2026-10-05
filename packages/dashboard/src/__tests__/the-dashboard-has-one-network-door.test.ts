// ════════════════════════════════════════════════════════════════════════════
// THE DASHBOARD HAS ONE NETWORK DOOR, AND THIS IS THE CENSUS THAT KEEPS IT ONE.
//
// ── WHAT THIS IS FOR (BACKLOG line 31) ──
// Sixteen files under `src/` called the global `fetch` themselves. The cost was
// not style: a component whose network call is a bare `fetch` has NO SEAM, so a
// test that mounts it either reaches a live `:3001` — passing for a reason that
// is not the code — or trips the tripwire in `vitest.setup.ts`. That is why
// `every-major-page-mounts.test.tsx` had to replace the tripwire with a
// 503-answering stub for the whole suite, and why the credential-chip clause
// needed a `vi.stubGlobal` of its own to render a link.
//
// Both of those concessions are gone now, which is the behavioural half of the
// proof. This file is the SOURCE half, and the reason it exists is that the
// behavioural half cannot see a new offender in a component no page mounts.
//
// ── IT COUNTS BOTH WAYS, WHICH IS THE WHOLE POINT (G4) ──
// "Zero direct callers" on its own is a clause that also passes on an empty
// directory, or after someone deletes the door and goes back to bare `fetch`
// everywhere but the files this test happens to name. So three things are
// asserted together:
//
//   1. NO direct `fetch(` outside the door — a new direct caller reds it;
//   2. the door still HAS exactly one `fetch(` call — removing or multiplying
//      the single call site reds it;
//   3. each of the four wrappers is actually APPLIED by some caller — a wrapper
//      that stops being used, or a door that gets bypassed wholesale, reds it.
//
// And the scan proves it ran: a census that silently matched nothing is the
// failure mode that makes a clause like this worthless, so the file count is
// asserted too.
//
// ── IT READS CODE, NOT PROSE (G4) ──
// Comments and string literals are STRIPPED before anything is matched. That is
// not fussiness: this very package now contains a dozen comments that say the
// words `fetch(` while explaining why they must not appear, and the header you
// are reading is one of them. A clause satisfiable by the prose above a call
// tests the comment, not the call.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const SRC = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

/** The door itself — the ONE file allowed to call `fetch`. */
const DOOR = path.join('lib', 'api.ts');

/**
 * The tripwire's own clause asserts that calling `fetch` THROWS. It has to name
 * the function to do that, and it is the assertion, not a network call.
 */
const ASSERTS_THE_TRIPWIRE = path.join('__tests__', 'the-dom-environment-provides-what-the-dashboard-uses.test.ts');

/**
 * Strip comments AND string/template literal CONTENTS, leaving executable
 * punctuation in place. A small state machine rather than a regex, because the
 * cases that matter are exactly the ones a regex gets wrong: `//` inside a URL
 * string, a quote inside a comment, a brace inside a template literal.
 *
 * Template EXPRESSIONS (`${...}`) are kept — a call can live inside one.
 */
function stripCommentsAndStrings(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i++;
        i++;
      }
      i++;
      out += '""';
      continue;
    }
    if (c === '`') {
      i++;
      while (i < source.length && source[i] !== '`') {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '$' && source[i + 1] === '{') {
          // Re-enter code mode for the expression, tracking brace depth.
          i += 2;
          let depth = 1;
          const start = i;
          while (i < source.length && depth > 0) {
            if (source[i] === '{') depth++;
            else if (source[i] === '}') depth--;
            if (depth > 0) i++;
          }
          out += ' ' + stripCommentsAndStrings(source.slice(start, i)) + ' ';
          i++; // past the closing brace
          continue;
        }
        i++;
      }
      i++;
      out += '``';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Every tracked source file under `src/`. */
function sourceFiles(dir: string = SRC): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { found.push(...sourceFiles(full)); continue; }
    if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

/**
 * A DIRECT call of the global `fetch`. `refetch(`, `prefetch(` and `x.fetch(`
 * are other functions and must not count — the first census of this defect
 * reported 19 files because it did not make that distinction, and four of them
 * were `void refetch()`.
 */
const DIRECT_FETCH = /(^|[^A-Za-z0-9_$.])fetch\s*[(<]/;

const FILES = sourceFiles();
const CODE = new Map<string, string>(
  FILES.map((f) => [path.relative(SRC, f), stripCommentsAndStrings(fs.readFileSync(f, 'utf8'))]),
);

describe('the dashboard calls fetch in exactly one place', () => {
  it('the census actually scanned this package', () => {
    // A scan that matched nothing would satisfy every clause below for the worst
    // possible reason.
    expect(FILES.length, 'the source walk found almost nothing — is SRC right?').toBeGreaterThan(100);
    expect(CODE.has(DOOR), 'lib/api.ts was not scanned').toBe(true);
  });

  it('⚠ no file outside lib/api.ts calls the global fetch', () => {
    const offenders: string[] = [];
    for (const [rel, code] of CODE) {
      if (rel === DOOR || rel === ASSERTS_THE_TRIPWIRE) continue;
      if (DIRECT_FETCH.test(code)) offenders.push(rel);
    }
    // The message is the fix, because whoever reds this will be the person who
    // just added the call.
    expect(
      offenders,
      'these call the global `fetch` directly, which leaves them with no door a test can mock — '
      + 'use `request` / `requestRaw` / `requestForm` / `fetchUrl` from `lib/api` instead',
    ).toEqual([]);
  });

  it('⚠ the door still has exactly ONE fetch call site', () => {
    const code = CODE.get(DOOR)!;
    const sites = code.match(/(^|[^A-Za-z0-9_$.])fetch\s*[(<]/g) ?? [];
    // One, not "at least one": the point of the door is that there is a single
    // place where auth headers, the CSRF token, the 401 bounce and the
    // never-throw contract are applied. A second call site is a second policy.
    expect(sites.length, 'lib/api.ts should call fetch once — in `throughTheDoor`').toBe(1);
    expect(code).toMatch(/const\s+throughTheDoor\s*=/);
  });

  it('⚠ all four wrappers are exported, and every one of them is USED', () => {
    const door = CODE.get(DOOR)!;
    const callers = [...CODE].filter(([rel]) => rel !== DOOR);
    for (const wrapper of ['request', 'requestRaw', 'requestForm', 'fetchUrl']) {
      expect(door, `lib/api.ts does not export ${wrapper}`)
        .toMatch(new RegExp(`export\\s+const\\s+${wrapper}\\s*=`));
      // APPLICATION, not presence: a wrapper nobody calls is a wrapper whose
      // behaviour nothing exercises, and the `api.` form counts as well as the
      // bare import.
      // `[(<]` and not `\\(`: these doors are generic, and the real call sites
      // read `requestForm<{ techniqueId: string }>(...)`. Matching only `(`
      // measured ZERO callers for `requestForm` while one existed six lines away
      // in `pages/Techniques.tsx` — a clause that passes for the wrong reason is
      // the thing this file is supposed to prevent.
      const applied = callers.filter(([, code]) =>
        new RegExp(`(^|[^A-Za-z0-9_$.])${wrapper}\\s*[(<]`).test(code)
        || new RegExp(`\\bapi\\.${wrapper}\\s*[(<]`).test(code));
      expect(applied.length, `nothing calls ${wrapper}`).toBeGreaterThan(0);
    }
  });
});

describe('the comment stripper is worth trusting', () => {
  // The census is only as good as this function, and its failure mode is SILENT
  // — a stripper that eats too much makes the whole file pass for free. So the
  // shapes that would break it are pinned here.
  it('drops comments but keeps code', () => {
    expect(stripCommentsAndStrings('// fetch(1)\nfetch(2)')).toMatch(DIRECT_FETCH);
    expect(stripCommentsAndStrings('// fetch(1)\nconst a = 1;')).not.toMatch(DIRECT_FETCH);
    expect(stripCommentsAndStrings('/* fetch(1) */ const a = 1;')).not.toMatch(DIRECT_FETCH);
  });

  it('is not fooled by a // inside a string, which is what regexes get wrong', () => {
    // If the `//` in the URL were treated as a comment, the real call after it
    // would vanish and the offending file would pass.
    expect(stripCommentsAndStrings(`const u = 'https://x.invalid'; fetch(u);`)).toMatch(DIRECT_FETCH);
  });

  it('keeps template EXPRESSIONS, where a call can hide', () => {
    expect(stripCommentsAndStrings('const s = `a${fetch(1)}b`;')).toMatch(DIRECT_FETCH);
    expect(stripCommentsAndStrings('const s = `a fetch( b`;')).not.toMatch(DIRECT_FETCH);
  });

  it('does not count refetch, prefetch or a method named fetch', () => {
    for (const line of ['void refetch();', 'prefetch(x);', 'client.fetch(x);', 'this.fetch(x);']) {
      expect(stripCommentsAndStrings(line), line).not.toMatch(DIRECT_FETCH);
    }
  });

  it('counts a call written with a generic, which is how these doors are called', () => {
    // `requestForm<{ id: string }>(...)` is the real shape in `pages/Techniques.tsx`.
    // A `\\(`-only matcher reads that as zero call sites.
    expect('request<Technique[]>(`/techniques`)').toMatch(/(^|[^A-Za-z0-9_$.])request\s*[(<]/);
  });
});
