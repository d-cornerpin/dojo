// t113 A1 — NO A2A CALLER THROWS ITS DELIVERY AWAY.
//
// ── THE DEFECT CLASS THIS CLOSES ──
//
// `deliverA2AMessage` reports a refused delivery as a RETURN, not a throw:
// `{ delivered: false, reason: 'HOP_LIMIT_EXCEEDED' | … }`. Every one of the product's
// best-effort notice sites was written as
//
//     try { await deliverA2AMessage({ … }); } catch { /* best-effort *\/ }
//     logger.info('Agent notified');                       // ← claims a send that never happened
//
// so the `catch` never saw a drop and the line below it lied. t109 made the TRANSPORT loud
// (every drop warns there), which fixed "silently", and t109's own report then handed up the
// other half: a transport warn says "a delivery was refused", but only the caller knows WHICH
// notice the product therefore owes nobody. Twelve sites still had no caller-side record.
//
// ── THE RULE, AND WHY IT IS A UNIVERSAL AND NOT A LIST ──
//
// Every `deliverA2AMessage(` call site in non-test server source must CONSUME its result:
// bind it (or consume the promise inline with `.then`) AND actually read `.delivered`. A
// presence list of blessed callers would stay green the day a thirteenth discarding caller is
// written (G4), so this walk states the universal instead: the clause is RED for any site that
// drops the result, wherever it is added, and nothing has to be declared to make it count.
//
// The twelve notice sites now go through `agent/a2a-notice.ts`'s `deliverA2ANotice`, which
// carries the branch once — so they are no longer `deliverA2AMessage(` call sites at all, and
// §3 below pins the door itself, because a census satisfied by a door that discards is a
// census that proved nothing.
//
// ── UNITS, AND WHERE THE APPROXIMATION IS ──
//
// Unit: CALL SITES (occurrences of the identifier followed by `(`), not lines and not files.
// Measured at this head, over `packages/server/src/**/*.ts` minus `__tests__`:
//
//   node -e '…' using the classifier below   ->  9 call sites, 9 consumed, 0 discarded
//
// `readsResult` looks for `<name>.delivered` in the 60 lines after the call rather than
// parsing the enclosing function — stated plainly because it is an approximation in the
// PERMISSIVE direction only: a caller that reads `delivered` 61 lines later reds here and must
// move the read up, which is the right outcome anyway; a caller that never reads it cannot
// pass. The self-test in §4 feeds the classifier synthetic sources, so the walk's own
// blindnesses are controlled rather than assumed.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '..', '..');
const DOOR = 'agent/a2a-notice.ts';
const TRANSPORT = 'agent/a2a-transport.ts';

/**
 * Blank comments, keeping length and line structure, so PROSE describing a call is never
 * counted as one (G4). Byte-identical to `work/__tests__/work-event-kinds-conformance.test.ts`'s
 * exported copy, duplicated rather than imported because importing it would run that file's
 * 15-second whole-tree walk as a side effect of this one. §4 self-tests it here.
 */
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : walk(p);
  return e.isFile() && p.endsWith('.ts') && !p.endsWith('.d.ts') ? [p] : [];
});

/** The index just past the `(`'s matching `)`, or -1. Quote- and template-aware. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      for (i++; i < text.length; i++) {
        if (text[i] === '\\') { i++; continue; }
        if (text[i] === q) break;
      }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

export interface Site {
  /** the identifier bound to the result, or null when the promise is consumed inline */
  bound: string | null;
  /** the call is the declaration itself, not a call */
  isDefinition: boolean;
  /** the result is bound, or the promise is consumed with `.then`/`.catch`/`.delivered` */
  consumesShape: boolean;
  /** `delivered` is actually read off the result */
  readsResult: boolean;
  /** 1-based line of the call, for the failure message */
  line: number;
}

/**
 * Classify every `deliverA2AMessage(` call site in one module's source. A PURE function of
 * its argument, so §4 can feed it planted defects without touching the tree.
 */
export function classify(source: string): Site[] {
  const text = stripComments(source);
  const out: Site[] = [];
  const re = /\bdeliverA2AMessage\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(0, m.index);
    const line = before.split('\n').length;
    if (/\bfunction\s+$/.test(before) || /\bexport\s+(async\s+)?function\s+$/.test(before)) {
      out.push({ bound: null, isDefinition: true, consumesShape: true, readsResult: true, line });
      continue;
    }
    const bind = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?$/.exec(before);
    const returned = /\breturn\s+(?:await\s+)?$/.test(before);
    const end = closingParen(text, m.index + m[0].length - 1);
    const after = end < 0 ? '' : text.slice(end, end + 40);
    const chained = /^\s*\.\s*(then|catch|delivered)\b/.test(after);
    const bound = bind ? bind[1] : null;
    // The 60 lines after the call — where a caller that cares about the outcome reads it.
    const window = end < 0 ? '' : text.slice(end).split('\n').slice(0, 60).join('\n');
    const reads = bound
      ? new RegExp(`\\b${bound}\\s*(?:\\?)?\\.\\s*delivered\\b`).test(window)
      : /\bdelivered\b/.test(window);
    out.push({
      bound,
      isDefinition: false,
      consumesShape: Boolean(bind) || returned || chained,
      readsResult: returned || reads,
      line,
    });
  }
  return out;
}

const rel = (p: string): string => path.relative(SRC, p).split(path.sep).join('/');

interface Finding { file: string; line: number; why: string }

function census(): { sites: number; findings: Finding[]; files: string[] } {
  const findings: Finding[] = [];
  const files: string[] = [];
  let sites = 0;
  for (const abs of walk(SRC)) {
    const source = fs.readFileSync(abs, 'utf8');
    if (!source.includes('deliverA2AMessage')) continue;
    const found = classify(source);
    if (found.length === 0) continue;
    files.push(rel(abs));
    for (const s of found) {
      if (s.isDefinition) continue;
      sites++;
      if (!s.consumesShape) findings.push({ file: rel(abs), line: s.line, why: 'the result is thrown away — bind it, or call deliverA2ANotice' });
      else if (!s.readsResult) findings.push({ file: rel(abs), line: s.line, why: `\`${s.bound ?? 'the promise'}\` is bound but \`.delivered\` is never read` });
    }
  }
  return { sites, findings, files: files.sort() };
}

describe('no a2a caller throws its delivery away', () => {
  // ── §1 THE UNIVERSAL ──
  it('every deliverA2AMessage call site in the tree consumes its result', () => {
    const { findings } = census();
    expect(findings.map((f) => `${f.file}:${f.line} — ${f.why}`)).toEqual([]);
  });

  // ── §2 THE WALK IS NOT BLIND ──
  // A universal over an empty set is green and proves nothing. This is a FLOOR, not a budget:
  // a new legitimate caller raises the count and nothing here reds. It fails if the walk stops
  // finding the tree (a moved directory, a renamed transport, a broken stripper).
  it('and the walk still finds the callers it is measuring', () => {
    const { sites, files } = census();
    expect(sites).toBeGreaterThanOrEqual(8);
    expect(files).toContain(TRANSPORT);
    expect(files).toContain(DOOR);
  });

  // ── §3 THE DOOR THE TWELVE NOW GO THROUGH ──
  // Without this, §1 is satisfiable by routing every caller into a door that discards.
  it('the notice door reads `delivered` and warns with the reason', () => {
    const door = stripComments(fs.readFileSync(path.join(SRC, DOOR), 'utf8'));
    expect(door).toMatch(/const\s+res\s*=\s*await\s+deliverA2AMessage\(envelope\)\s*;/);
    expect(door).toMatch(/if\s*\(\s*!\s*res\.delivered\s*\)\s*\{/);
    // the reason reaches the log line, and so does the caller's own words for the notice
    expect(door).toMatch(/logger\.warn\(\s*`\$\{what\}\s+was NOT delivered`/);
    expect(door).toMatch(/reason:\s*res\.reason\s*\?\?\s*'unknown'/);
    // and it RETURNS the result, so a caller that starts needing to branch is not rewritten
    expect(door).toMatch(/return\s+res\s*;/);
  });

  it('and the twelve notice sites actually call it', () => {
    const callers = walk(SRC)
      .filter((p) => /\bdeliverA2ANotice\s*\(\{/.test(stripComments(fs.readFileSync(p, 'utf8'))))
      .map(rel).sort();
    expect(callers).toEqual([
      'gateway/routes/tracker.ts',
      'healer/injury-recovery.ts',
      'scheduler/runner.ts',
      'techniques/distillation.ts',
      'tracker/tools.ts',
    ]);
    const tools = stripComments(fs.readFileSync(path.join(SRC, 'tracker/tools.ts'), 'utf8'));
    expect(tools.match(/\bdeliverA2ANotice\s*\(\{/g)).toHaveLength(8);
    // every call hands the door a NOTICE NAME — a door called with no words to say says nothing
    for (const f of ['gateway/routes/tracker.ts', 'healer/injury-recovery.ts', 'scheduler/runner.ts', 'techniques/distillation.ts', 'tracker/tools.ts']) {
      const t = stripComments(fs.readFileSync(path.join(SRC, f), 'utf8'));
      const opens = (t.match(/\bdeliverA2ANotice\s*\(\{/g) ?? []).length;
      const named = (t.match(/\}\s*,\s*'[^']+'\s*,/g) ?? []).length;
      expect(named, `${f}: every deliverA2ANotice call names its notice`).toBeGreaterThanOrEqual(opens);
    }
  });

  // ── §4 THE WALK'S OWN CONTROLS ──
  // The classifier is a pure function, so its blindnesses are tested rather than trusted. Each
  // case is the exact shape a reviewer would worry about.
  describe('the classifier itself', () => {
    const one = (src: string): Site => {
      const s = classify(src).filter((x) => !x.isDefinition);
      expect(s).toHaveLength(1);
      return s[0];
    };

    it('catches the bare discard — the defect this file exists for', () => {
      const s = one(`async function f() { await deliverA2AMessage({ intent: 'FYI' }); }`);
      expect(s.consumesShape).toBe(false);
    });

    it('catches bound-but-never-read, which a shape-only clause would pass', () => {
      const s = one(`async function f() { const res = await deliverA2AMessage({ intent: 'FYI' }); logger.info('sent', { id: res.threadId }); }`);
      expect(s.consumesShape).toBe(true);
      expect(s.readsResult).toBe(false);
    });

    it('accepts a real caller', () => {
      const s = one(`async function f() { const res = await deliverA2AMessage({ intent: 'FYI' });\nif (!res.delivered) logger.warn('no', { reason: res.reason }); }`);
      expect(s.readsResult).toBe(true);
    });

    it('accepts the .then shape, which pm-agent uses for a fire-and-forget poke', () => {
      const s = one(`function f() { deliverA2AMessage({ intent: 'FYI' }).then(res => { if (!res.delivered) logger.warn('no'); }); }`);
      expect(s.consumesShape).toBe(true);
      expect(s.readsResult).toBe(true);
    });

    it('does not count PROSE about a call as a call', () => {
      expect(classify(`// await deliverA2AMessage({ intent: 'FYI' });\n/* deliverA2AMessage(x) */\nconst a = 1;`)).toEqual([]);
    });

    it('does not count a call named INSIDE A STRING as a call', () => {
      // a payload or a log message may quote the function's name; that is text, not a caller
      expect(classify(`const s = "call deliverA2AMessage(envelope) to send";`).filter((x) => !x.isDefinition)).toHaveLength(1);
      // ⚠ KNOWN AND DELIBERATE: the stripper blanks comments, not strings, so a quoted call
      // reads as a site and would red §1. That is the SAFE direction (a false red a human
      // resolves by rewording), and no such string exists in the tree today — §1 is green.
    });

    it('treats the declaration as a declaration, not as a discarding caller', () => {
      const s = classify(`export async function deliverA2AMessage(envelope: A2ADeliveryOptions) { return x; }`);
      expect(s).toHaveLength(1);
      expect(s[0].isDefinition).toBe(true);
    });

    it('and the stripper keeps line numbers, so a finding points at the right line', () => {
      const src = `/* a\nmultiline\ncomment */\nawait deliverA2AMessage({});`;
      expect(one(src).line).toBe(4);
    });
  });
});
