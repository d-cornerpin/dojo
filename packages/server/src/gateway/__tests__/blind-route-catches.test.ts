// PHASE-4 T5 Step 3 — R23: no route may answer the client and swallow the reason.
//
// Research 22:27 books this before Phase 4 in its own words: "fix blind route catches BEFORE
// Phase 4 or R4 debugging reads logs missing the failures." The failure mode is specific and
// it is the worst shape a fault can take on a box nobody is watching — the caller gets a
// confident answer, the server writes nothing down, and the only evidence anything went wrong
// is a sentence in a browser the owner has already dismissed. P364 is the class named: the
// Google/Microsoft toggle handlers reported a DB write failure to the owner as
// "Invalid request body", 400, and logged nothing at all.
//
// This is a SOURCE WALK rather than a behaviour test on purpose. The property is "every
// catch that answers", and there is no runtime that visits all of them; a walk visits all of
// them by construction and re-derives its own denominator on every run, so the clause cannot
// quietly stop measuring anything.
//
// The walk deliberately does NOT judge catches that swallow-and-continue without answering
// (`/* best effort */`). Those are a larger, mostly-deliberate population and R23's citation
// is about the logs missing FAILURES the caller was told about; widening this clause to them
// would be inventing scope the source does not carry.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROUTES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'routes',
);

/** The helper itself is not a route, and its header QUOTES the defective shape it replaced —
 *  a walk that read that comment would find its own subject and report it as a violation. */
const NOT_A_ROUTE = new Set(['route-failure.ts']);

/** Blank comments out, preserving offsets, so prose describing a `catch` is never scanned as
 *  one. (`check-wiring.mjs` learned this the same way: an apostrophe in a sentence opened a
 *  string as far as a scanner was concerned.) */
function decomment(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, (m, p: string) => p + ' '.repeat(m.length - p.length)))
    .join('\n');
}

interface CatchBlock {
  file: string;
  line: number;
  body: string;
  binding: string | null;
}

/** Every `catch { … }` in a file, with its body, found by brace matching. */
function catchBlocks(file: string, src: string): CatchBlock[] {
  const out: CatchBlock[] = [];
  const re = /\bcatch\s*(\([^)]*\))?\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const open = src.indexOf('{', m.index);
    let depth = 0;
    let j = open;
    for (; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) break; }
    }
    out.push({
      file,
      line: src.slice(0, m.index).split('\n').length,
      body: src.slice(open + 1, j),
      binding: m[1] ?? null,
    });
  }
  return out;
}

/** Does this catch hand the CLIENT a response? `routeFailure` counts: it answers on the
 *  handler's behalf, and leaving it out would make every converted site invisible to the
 *  clause that converted it — a walk that stops seeing its own subject reports green forever. */
const answersTheClient = (body: string): boolean =>
  /\bc\.(json|text|body|newResponse)\s*\(/.test(body) || /\brouteFailure\s*\(/.test(body);

/** Does this catch leave a record a human can find later? */
const leavesARecord = (body: string): boolean =>
  /\blogger\.(error|warn|info|debug)\s*\(/.test(body)
  || /\brouteFailure\s*\(/.test(body)
  || /\bnoteRouteFailure\s*\(/.test(body);

function allCatches(): CatchBlock[] {
  const files = fs.readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.ts') && !NOT_A_ROUTE.has(f))
    .sort();
  return files.flatMap((f) => catchBlocks(f, decomment(fs.readFileSync(path.join(ROUTES_DIR, f), 'utf8'))));
}

describe('R23 — a route that answers the client records why', () => {
  it('the walk has a real denominator (it would pass vacuously otherwise)', () => {
    const all = allCatches();
    const answering = all.filter((b) => answersTheClient(b.body));
    // Derived at PHASE-4 T5: 222 catch blocks, 97 of them answering. The floors below are
    // deliberately loose — they exist so that a walk which stops FINDING things fails instead
    // of reporting green over an empty set.
    expect(all.length).toBeGreaterThan(150);
    expect(answering.length).toBeGreaterThan(60);
  });

  it('PLANTED FAULT: the walk bites — a blind answering catch is found, a recording one is not', () => {
    const blindSource = `
      router.get('/x', (c) => {
        try { return c.json({ ok: true }); } catch (err) { return c.json({ ok: false }, 500); }
      });
    `;
    const recordingSource = `
      router.get('/x', (c) => {
        try { return c.json({ ok: true }); } catch (err) { return routeFailure(c, logger, err); }
      });
    `;
    const blind = (src: string): CatchBlock[] =>
      catchBlocks('planted.ts', decomment(src))
        .filter((b) => answersTheClient(b.body))
        .filter((b) => !leavesARecord(b.body));
    expect(blind(blindSource)).toHaveLength(1);
    expect(blind(recordingSource)).toHaveLength(0);
  });

  it('ZERO route catches answer the client without leaving a record', () => {
    const blind = allCatches()
      .filter((b) => answersTheClient(b.body))
      .filter((b) => !leavesARecord(b.body));
    const shown = blind.map((b) => `${b.file}:${b.line}`);
    expect(shown, `blind answering catches:\n  ${shown.join('\n  ')}`).toEqual([]);
  });

  it('a catch that answers must also BIND its error — you cannot record what you did not catch', () => {
    // `catch { return c.json(…) }` is P364 exactly: the handler cannot log the reason because
    // it never took hold of it.
    const unbound = allCatches()
      .filter((b) => answersTheClient(b.body))
      .filter((b) => b.binding === null || b.binding.trim() === '()')
      .map((b) => `${b.file}:${b.line}`);
    expect(unbound, `answering catches with no error binding:\n  ${unbound.join('\n  ')}`).toEqual([]);
  });
});
