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
  'agent/v2/honest-stop.ts': [
    { cls: 'agent-trouble', severity: 'notice', what: 'an agent is parked because none of its models can hold it (once per condition; its card ends when the agent is released, t148)' },
    { cls: 'budget', severity: 'notice', what: 'a budget stop parked an agent: the limit is reached (once per budget window, shared with the crossing alert; its card ends with the last release, t167)' },
  ],
  'agent/v2/full-context-wait.ts': [
    { cls: 'agent-trouble', severity: 'notice', what: 't168: a full agent whose compaction brake let go and whose pass still reclaimed nothing is stuck (the Healer\'s stuck words and card, once per incident; ends when a pass reclaims or the context fits)' },
  ],
  'agent/rate-limit-retry.ts': [
    { cls: 'agent-trouble', severity: 'critical', what: 'rate-limit retries exhausted' },
  ],
  'healer/injury-recovery.ts': [
    { cls: 'agent-trouble', severity: 'critical', what: 'the Healer itself is broken' },
    { cls: 'agent-trouble', severity: 'notice', what: 't143 BROKEN: a provider refused the agent in a way only the owner can fix (once per incident)' },
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
  'tracker/liveness.ts': [
    { cls: 'agent-trouble', severity: 'notice', what: 't143 SILENT: no movement at all past the agent\'s silent window (once per incident)' },
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
    // r6: costs/budget-cards.ts (the window and the card) READS them; budget.ts is the one writer.
    expect(writersOf(/alert_(50|75|90)_sent/)).toEqual(['costs/budget-cards.ts', 'costs/budget.ts']);
    expect(migrationsTouching(/alert_(50|75|90)_sent/)).toEqual(['004_phase4.sql', '190_owner_notice_latches.sql']);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 field fix 3 (#9): THE OWNER-CARD DOOR'S CENSUS: every card declares what it asks of the owner.
//
// Owner ruling OR-FIELD3 (c): "It shouldn't be a persistent notification if it doesn't require the intervention of
// the user. It also shouldn't be red." So the door (`services/owner-card-frames.ts`) takes a declared class:
//   - action: he must do something (a sticky card, the orb's red alert, re-derived on every load);
//   - informational: worth knowing, nothing to do (a toast that leaves by itself, never red, never re-derived);
//   - progress: background work that ends on its own (no card: the orb's task glyph, `ownerProgressFrame`).
// A new caller fails here until it is classified; a caller that changes class fails too. The reason is the record.
// ════════════════════════════════════════════════════════════════════════════════════════
type CardClass = 'action' | 'informational' | 'progress';
interface CardSite { cls: CardClass; what: string; why: string }
const CARD_CLASSES: readonly CardClass[] = ['action', 'informational', 'progress'];

/** Every `ownerCardFrame(` and `ownerProgressFrame('start'` call, in source order within its file. */
const CARD_CENSUS: Record<string, CardSite[]> = {
  'agent/decision-switch.ts': [
    { cls: 'informational', what: 'the decision model now answers a question itself', why: 'nothing to do: if it gets worse the Dojo goes back to the rule by itself' },
  ],
  'agent/local-model-fit.ts': [
    { cls: 'informational', what: "a local model's memory fit could not be checked when it was picked", why: 'nothing to do: it is checked at the first load and refused then if it does not fit' },
  ],
  'memory/catch-up-state.ts': [
    { cls: 'progress', what: 'the agent is summarising its older memory in the background (shown at a turn on notes)', why: 'finishes on its own; replies are not held up' },
  ],
  'memory/embedding-switch.ts': [
    { cls: 'informational', what: 'the memory search model became a paid one; older memories are unsearchable until re-processed', why: 'review round L1: an optional choice with no button; nothing is broken and nothing is billed until he acts' },
  ],
  'migration/import-recovery.ts': [
    { cls: 'action', what: 'an import failed and stopped what it stopped', why: 'he restarts the Dojo from the menu bar' },
  ],
  'services/imessage-bridge.ts': [
    { cls: 'action', what: 'every critical or notice text the platform sends him (the sendAlert census above)', why: 'by ruling, the phone door carries true blockers only' },
  ],
  'services/local-standard.ts': [
    { cls: 'informational', what: "the Dojo's own two local models could not be installed yet (at boot)", why: 'nothing to do: the Dojo keeps trying whenever Ollama runs (OR-UPKEEP-AUTOMATIC)' },
    { cls: 'informational', what: "the Dojo's own two local models could not be installed yet (after an install pass)", why: 'the same condition, the same answer' },
  ],
  'services/ollama-model-limit.ts': [
    { cls: 'informational', what: "the Dojo could not raise Ollama's loaded-model limit", why: 'nothing to do: everything keeps working and the Dojo tries again at its next start' },
  ],
  'services/ollama-upgrade.ts': [
    { cls: 'action', what: 'a local model needs a newer Ollama and the Dojo could not update it by itself', why: 'one of the few cases the Dojo cannot fix (another user\'s or the system\'s Ollama, no Homebrew): OR-UPKEEP-AUTOMATIC\'s ONE plain card' },
    { cls: 'action', what: 'Ollama stopped during its update and has not come back', why: 'the local models are down until the next start; his Repair press is the one way back sooner' },
    { cls: 'action', what: 'the same condition, from the restart path', why: 'the same answer' },
  ],
  'vault/lessons-announce.ts': [
    { cls: 'informational', what: "a count of yesterday's lessons, in the Dreamer's report", why: 'a report to read, nothing to do' },
  ],
};

function findCardCalls(): Record<string, CardClass[]> {
  const out: Record<string, CardClass[]> = {};
  for (const abs of sourceFiles()) {
    const rel = path.relative(SRC, abs).split(path.sep).join('/');
    if (rel === 'services/owner-card-frames.ts') continue;   // the door itself
    const code = stripComments(fs.readFileSync(abs, 'utf8'));
    const re = /\b(ownerCardFrame|ownerProgressFrame)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const open = m.index + m[0].length - 1;
      const text = code.slice(open, closeOf(code, open));
      if (m[1] === 'ownerProgressFrame' && !/^\(\s*'start'/.test(text)) continue;   // its end, like `ownerCardEnded`
      const cls: CardClass | '<not a literal>' = m[1] === 'ownerProgressFrame' ? 'progress'
        : (/,\s*'(action|informational)'\s*\)$/.exec(text)?.[1] as CardClass | undefined) ?? '<not a literal>';
      (out[rel] ??= []).push(cls as CardClass);
    }
  }
  return out;
}

describe('the owner-card door census (field fix 3 #9)', () => {
  const actual = findCardCalls();

  it('every caller declares its class, in order, and every declared caller exists', () => {
    const declared: Record<string, CardClass[]> = {};
    for (const [rel, sites] of Object.entries(CARD_CENSUS)) declared[rel] = sites.map((s) => s.cls);
    expect(actual, 'a new or changed owner-card caller: classify it in CARD_CENSUS (action | informational | progress)').toEqual(declared);
  });

  it('only the three classes exist, and every entry says why', () => {
    for (const sites of Object.values(CARD_CENSUS)) {
      for (const s of sites) { expect(CARD_CLASSES).toContain(s.cls); expect(s.why.length).toBeGreaterThan(0); }
    }
  });

  it('a card that needs no action is never re-derived on a reload: the healer list skips the informational conditions', () => {
    const notices = fs.readFileSync(path.join(SRC, 'healer/owner-notices.ts'), 'utf8');
    for (const key of ["'standard-models'", "'ollama-limit-failed'", "'fitunchecked:'", "'embedding-switch'"]) {
      expect(/export function isInformationalCondition[\s\S]*?\n}/.exec(notices)?.[0], `${key} is informational`).toContain(key);
    }
    expect(notices).toMatch(/!isInformationalCondition\(key\)/);
    const config = stripComments(fs.readFileSync(path.join(SRC, 'gateway/routes/config.ts'), 'utf8'));
    expect(config, 'the catch-up is progress, not a lasting card').not.toMatch(/catchUpOwnerCards/);
  });
});
