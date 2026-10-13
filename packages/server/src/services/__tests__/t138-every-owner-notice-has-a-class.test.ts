// ════════════════════════════════════════════════════════════════════════════════════════
// t138 — THE OWNER-NOTICE DOOR'S CENSUS: every `sendAlert` caller, by class, counted both ways.
//
// `sendAlert` (services/imessage-bridge.ts) is the platform's one door to the owner's phone —
// the only place the PLATFORM, rather than an agent, speaks to him. Owner rulings bound what may
// pass through it:
//   - ruling 10(a): the platform does not tell the owner things, the agent does — except the
//     platform telling him the platform itself is in trouble;
//   - OR-V333-SET (3): plus exactly two more — budget alerts, and an agent that is broken or
//     silent.
// So there are three classes and no fourth. This census names every call site's class and
// severity. A NEW caller anywhere in the server fails here until someone classifies it (and a
// class outside the three needs the owner first); a REMOVED caller fails as a stale entry; a
// caller that quietly changes severity fails too. The table is the record; the reasons are
// short on purpose.
//
// Severity: `critical` and `notice` reach the phone (`critical` with a "[CRITICAL]" prefix);
// `warning` and `info` never do, which is the v2.3.19 owner request ("only true blockers or true
// issues") that this door still honours. A muted entry is therefore a class the owner is NOT
// hearing about, and each one names who owns turning it on.
// ════════════════════════════════════════════════════════════════════════════════════════

// RED-FIRST at 00a2b34d: clauses marked `it.fails` are the witness, failing before the fix;
// the fix commits flip them to `it`.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..');

type NoticeClass = 'budget' | 'agent-trouble' | 'platform-trouble';
type Severity = 'critical' | 'notice' | 'warning' | 'info';
/** The dashboard side of a phone-bound site (t138 round 3): it raises a card (default), raises
 *  none (`none`, a status line), or removes the trouble card it answers (`clears`, an all-clear). */
type Card = 'card' | 'none' | 'clears';
interface Site { cls: NoticeClass; severity: Severity; what: string; muted?: string; card?: Card }

const CLASSES: readonly NoticeClass[] = ['budget', 'agent-trouble', 'platform-trouble'];

/** Every caller, in source order within its file. */
const CENSUS: Record<string, Site[]> = {
  'costs/budget.ts': [
    { cls: 'budget', severity: 'notice', what: 'a daily/weekly/monthly budget crossed 50/75/90% (highest crossed, once)' },
  ],
  'costs/provider-balance-check.ts': [
    { cls: 'budget', severity: 'notice', what: 'a provider account balance fell to its warning threshold (once)' },
  ],
  'agent/errors.ts': [
    { cls: 'agent-trouble', severity: 'notice', what: 'an agent was paused after repeated errors' },
    {
      cls: 'agent-trouble', severity: 'warning', what: 'an agent is being rate-limited (strike 3); it will retry by itself',
      muted: 'ruling R-V333-4 (orchestrator, following the owner\'s "true blockers only"): not a blocker, so dashboard only — rate-limit-retry.ts shows the agent as rate-limited; "retries exhausted" stays on the phone at critical',
    },
  ],
  'agent/rate-limit-retry.ts': [
    { cls: 'agent-trouble', severity: 'critical', what: 'rate-limit retries exhausted' },
  ],
  'healer/injury-recovery.ts': [
    { cls: 'agent-trouble', severity: 'critical', what: 'the Healer itself is broken' },
    { cls: 'agent-trouble', severity: 'notice', what: 'auto-recovery gave up on a stuck agent (first entry into backoff)' },
    { cls: 'agent-trouble', severity: 'critical', what: 'an agent is stuck and the Healer is missing' },
  ],
  'google/auth.ts': [
    { cls: 'platform-trouble', severity: 'critical', what: 'a Google account connection expired' },
    { cls: 'platform-trouble', severity: 'notice', what: 'the all-clear: it reconnected on its own (its card ends where the sign-in is restored)', card: 'none' },
  ],
  'microsoft/auth.ts': [
    { cls: 'platform-trouble', severity: 'critical', what: 'a Microsoft account connection expired' },
    { cls: 'platform-trouble', severity: 'notice', what: 'the all-clear: it reconnected on its own (its card ends where the sign-in is restored)', card: 'none' },
  ],
  'services/memory-low-notice.ts': [
    { cls: 'platform-trouble', severity: 'critical', what: 'the box is nearly out of memory (once per low stretch, round 3)' },
  ],
  'services/tunnel.ts': [
    { cls: 'platform-trouble', severity: 'notice', what: 'the remote address changed; the old link no longer reaches the box', card: 'none' },
  ],
  'services/watcher-status.ts': [
    { cls: 'platform-trouble', severity: 'critical', what: 'a mail/chat watcher has been failing' },
    { cls: 'platform-trouble', severity: 'critical', what: 'the all-clear: the watcher recovered', card: 'clears' },
  ],
};

/** Comments out, string contents kept: a matcher must never read prose as a call. */
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== '__tests__' && e.name !== 'node_modules') walk(abs);
        continue;
      }
      if (/\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(abs);
    }
  };
  walk(SRC);
  return out.sort();
}

/** Index just past the `)` that closes the call whose `(` is at `open`. Skips string,
 *  template (with nested `${}`) and regex-free code; enough for call sites in this tree. */
function closeOf(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '\'' || c === '"') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '`') {
      i = skipTemplate(src, i);
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') { depth--; if (depth === 0) return i + 1; }
  }
  throw new Error('unbalanced call');
}
function skipTemplate(src: string, start: number): number {
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue; }
    if (src[i] === '`') return i;
    if (src[i] === '$' && src[i + 1] === '{') {
      let depth = 1;
      for (i += 2; i < src.length && depth > 0; i++) {
        if (src[i] === '`') { i = skipTemplate(src, i); continue; }
        if (src[i] === '{') depth++;
        if (src[i] === '}') depth--;
      }
      i--;
    }
  }
  throw new Error('unterminated template');
}

/**
 * Every mention of `sendAlert` that is NOT one of the three legitimate shapes — a call
 * (`sendAlert(` or `x.sendAlert(`), an import binding (`import { sendAlert } from …`,
 * `const { sendAlert } = await import(…)`), or the definition. What is left is a way to reach
 * the door the call census cannot count: a local alias (`const door = sendAlert; door(…)`),
 * a re-export (`export { sendAlert }`), a value handed to something else (`run(sendAlert)`),
 * an `as` rename. Fix round 1, M2: the first cut caught only `as` and `:` renames.
 */
function bareReferences(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/\bsendAlert\b/g)) {
    const i = m.index ?? 0;
    const after = code.slice(i + m[0].length);
    if (/^\s*\(/.test(after)) continue; // a call, or the definition
    const open = code.lastIndexOf('{', i);
    const close = code.indexOf('}', i);
    if (open !== -1 && close !== -1 && !code.slice(open + 1, i).includes('}')) {
      const inside = code.slice(open + 1, close);
      const before = code.slice(Math.max(0, open - 12), open);
      const tail = code.slice(close + 1, close + 40);
      const plain = !/\bsendAlert\s+as\b/.test(inside) && !/\bsendAlert\s*:/.test(inside);
      if (plain && /import\s*(?:type\s*)?$/.test(before) && /^\s*from\b/.test(tail)) continue;
      if (plain && /(?:const|let|var)\s*$/.test(before) && /^\s*=\s*await\s+import\s*\(/.test(tail)) continue;
    }
    const line = code.slice(0, i).split('\n').length;
    out.push(`line ${line}: ${code.slice(Math.max(0, i - 30), i + 30).replace(/\s+/g, ' ').trim()}`);
  }
  return out;
}

interface Found { rel: string; severity: string; card: Card }

/** Every `sendAlert(…)` CALL in the server's source (the definition excluded), with the
 *  severity literal it passes as its last argument (or `<not a literal>`). */
function findCalls(): { calls: Found[]; importers: string[]; aliased: string[] } {
  const calls: Found[] = [];
  const importers: string[] = [];
  const aliased: string[] = [];
  for (const abs of sourceFiles()) {
    const rel = path.relative(SRC, abs).split(path.sep).join('/');
    const code = stripComments(fs.readFileSync(abs, 'utf8'));
    for (const where of bareReferences(code)) aliased.push(`${rel}: ${where}`);
    if (/import\s*\{[^}]*\bsendAlert\b[^}]*\}\s*from/.test(code) || /\{\s*sendAlert\s*\}\s*=\s*await\s+import/.test(code)) {
      importers.push(rel);
    }
    const re = /\bsendAlert\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      if (/function\s+$/.test(code.slice(Math.max(0, m.index - 20), m.index))) continue;
      const open = m.index + m[0].length - 1;
      const text = code.slice(open, closeOf(code, open));
      // The severity is the second argument; an options object may follow it (t138 round 3).
      const sev = /,\s*'(info|warning|critical|notice)'\s*(?:,[\s\S]*)?\)$/.exec(text);
      const card: Card = /\bclears\s*:/.test(text) ? 'clears' : /\bcard\s*:\s*false\b/.test(text) ? 'none' : 'card';
      calls.push({ rel, severity: sev ? sev[1] : '<not a literal>', card });
    }
  }
  return { calls, importers, aliased };
}

describe('the owner-notice census', () => {
  const { calls, importers, aliased } = findCalls();

  it('every caller is declared, in order, with its severity — and every declared caller exists', () => {
    const actual: Record<string, string[]> = {};
    for (const c of calls) (actual[c.rel] ??= []).push(c.severity);
    const declared: Record<string, string[]> = {};
    for (const [rel, sites] of Object.entries(CENSUS)) declared[rel] = sites.map((s) => s.severity);
    expect(actual, 'a new or changed sendAlert caller: classify it in CENSUS (budget | agent-trouble | platform-trouble)').toEqual(declared);
  });

  it('every caller raises, withholds or clears its dashboard card as declared (t138 round 3)', () => {
    const actual: Record<string, Card[]> = {};
    for (const c of calls) (actual[c.rel] ??= []).push(c.card);
    const declared: Record<string, Card[]> = {};
    for (const [rel, sites] of Object.entries(CENSUS)) declared[rel] = sites.map((s) => s.card ?? 'card');
    expect(actual, 'an all-clear or status line must declare its card; a trouble notice raises one').toEqual(declared);
    const noCard = Object.values(CENSUS).flat().filter((s) => (s.card ?? 'card') !== 'card');
    expect(noCard.every((s) => s.cls === 'platform-trouble'), 'budget and agent-trouble always raise a card').toBe(true);
  });

  it('every file that imports the door calls it, and every caller imports it; no alias, re-export or hand-off of the door', () => {
    expect(aliased, 'a reference to sendAlert that is not a call, an import or the definition').toEqual([]);
    const callerFiles = [...new Set(calls.map((c) => c.rel))].sort();
    expect(importers.sort()).toEqual(callerFiles);
  });

  it('only the three ruled classes exist', () => {
    for (const sites of Object.values(CENSUS)) {
      for (const s of sites) expect(CLASSES).toContain(s.cls);
    }
  });

  it('the two classes the owner asked to hear about reach the phone — except the one ruled not a blocker', () => {
    const muted = Object.entries(CENSUS).flatMap(([rel, sites]) =>
      sites.filter((s) => s.severity === 'warning' || s.severity === 'info').map((s) => ({ rel, ...s })));
    for (const m of muted) expect(m.muted, `${m.rel}: a muted notice must name who turns it on`).toBeTruthy();
    expect(muted.map((m) => `${m.rel}: ${m.what}`)).toEqual(['agent/errors.ts: an agent is being rate-limited (strike 3); it will retry by itself']);
    const budget = Object.values(CENSUS).flat().filter((s) => s.cls === 'budget');
    expect(budget.length).toBeGreaterThan(0);
    expect(budget.every((s) => s.severity === 'notice')).toBe(true);
  });
});

describe('the alert latches have ONE writer each', () => {
  const writersOf = (token: RegExp): string[] => sourceFiles()
    .filter((abs) => token.test(stripComments(fs.readFileSync(abs, 'utf8'))))
    .map((abs) => path.relative(SRC, abs).split(path.sep).join('/'));
  const migrationsTouching = (token: RegExp): string[] => fs.readdirSync(path.join(SRC, 'db', 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => token.test(fs.readFileSync(path.join(SRC, 'db', 'migrations', f), 'utf8').replace(/--[^\n]*/g, '')));

  it('the provider-balance latch lives only in the background check (the Ledger routes only read)', () => {
    expect(writersOf(/threshold_alerted/)).toEqual(['costs/provider-balance-check.ts']);
    expect(migrationsTouching(/threshold_alerted/), 'the one upgrade clean-up').toEqual(['190_owner_notice_latches.sql']);
  });

  it('the budget latches live only in the budget module', () => {
    expect(writersOf(/alert_(50|75|90)_sent/)).toEqual(['costs/budget.ts']);
    expect(migrationsTouching(/alert_(50|75|90)_sent/)).toEqual(['004_phase4.sql', '190_owner_notice_latches.sql']);
  });
});
