// PHASE-6 T10 Step 1b — THE ERROR TAXONOMY IS ALREADY SINGLE-SOURCED. THIS KEEPS IT THAT WAY.
//
// ── WHAT THIS TASK WAS TOLD TO DO, AND WHY IT DID NOT DO IT ──
//
// PHASE-6.md T10 inherited from research 09 the instruction *"recovery.ts absorbs
// injury-recovery's classifier"* — "error classification ×3". T0-SURVEY re-derived it at
// the phase base and the instruction was **corrected in place, dated**: the consolidation
// ALREADY LANDED, at PHASE-4 T5. Executing the absorb would have REVERSED a landed, argued
// decision, which is the named hazard of this task.
//
// Re-verified at this task's own HEAD (#14 — a verdict is re-checked before it is acted on):
//
//   agent/provider-error.ts                    317 lines, ONE prose->class table
//   non-test importers of it                   8   (errors · model · rate-limit-retry ·
//                                                   tool-outcome · classifiers/errors ·
//                                                   classifiers/provider · v2/recovery ·
//                                                   healer/injury-recovery)
//   surviving `classifyError` functions        2, BOTH delegating to it
//     v2/recovery.ts        -> ClassifiedError (engine recovery kinds)
//     healer/injury-recovery.ts -> string      (healer diagnostic buckets)
//
// The two wrappers are NOT duplicates and their own comments say why: each adds buckets with
// no HTTP equivalent (context corruption, config, output truncation), and
// `injury-recovery.ts` holds a persisted STRING — `agents.last_error` — where the status
// that produced it is long gone, which is exactly why it must go through the shared table
// rather than keep a sixth private copy.
//
// ── SO WHAT LANDS HERE IS A CENSUS, NOT A REBUILD ──
//
// The BEHAVIOUR of the table is already proven by `agent/__tests__/provider-error-
// classification.test.ts` — the adversarial token counts, the false negative, the token-
// boundary matching. That suite is CITED, never restated. What did not exist is the
// STRUCTURAL guard: nothing stopped a fifth file from growing its own prose table again, the
// way five files had one before PHASE-4 T5. That is what this walk is.
//
// ── THE INCIDENT THE SINGLE SOURCE EXISTS FOR, IN ONE LINE ──
//
// `classifyPlatformError` read `message.includes('401')` and Anthropic's over-length error
// reads "prompt is too long: 204015 tokens > 200000 maximum" — the token count CONTAINS
// "401". The owner was told his API key was invalid because his prompt was too long. Any new
// private prose table is a new chance to re-derive that, which is why the census is on the
// PROBE SHAPE and not only on the function name.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { classifyProviderErrorText } from '../provider-error.js';

const SRC = path.join(__dirname, '..', '..');

/** THE ONE PROSE TABLE. */
const TAXONOMY_MODULE = 'agent/provider-error.ts';

/**
 * Every module allowed to read provider-error PROSE, with the role that earns it. A fifth
 * entry appearing here is the third-table regression, and the walk names the file.
 */
const PROSE_READERS: Record<string, string> = {
  [TAXONOMY_MODULE]:
    'THE TABLE — the one prose->class mapping, reached only when there is no status and no transport code',
  'agent/v2/classifiers/provider.ts':
    'NARROWER — calls the table FIRST and only narrows what it already ruled `bad_request`/`unknown` into a remediation kind. Asserted below: the call precedes the first probe.',
  'agent/v2/classifiers/errors.ts':
    'WRAPPER — switches on the table\'s class, plus one named residue: a credential named in prose with no status behind it, which the table cannot see',
  'healer/injury-recovery.ts':
    'WRAPPER — holds a persisted `agents.last_error` STRING with its status long gone; delegates, and adds only the dojo buckets (context corruption, config) that have no HTTP equivalent',
};

/** The two sanctioned wrappers, by module and by the delegation each must show. */
const SANCTIONED_WRAPPERS: Array<{ module: string; delegatesTo: RegExp }> = [
  { module: 'agent/v2/recovery.ts', delegatesTo: /classifyProviderErrorText\(/ },
  { module: 'healer/injury-recovery.ts', delegatesTo: /classifyProviderErrorText\(/ },
];

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'migrations') continue;
      walk(fp, acc);
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) acc.push(fp);
  }
  return acc;
}

const rel = (f: string): string => path.relative(SRC, f).split(path.sep).join('/');
const sourceFiles = (): string[] => walk(SRC).map(rel).sort();
const read = (r: string): string => fs.readFileSync(path.join(SRC, r), 'utf8');

/** Blank comments, keeping line count: this file's own prose names every banned probe. */
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

/**
 * A PROVIDER-ERROR PROSE PROBE: an HTTP status searched for as TEXT, or provider-error
 * vocabulary searched for as text. Matched on the SHAPE rather than on a function name,
 * because the five tables PHASE-4 T5 deleted did not share a name — they shared this.
 */
const PROBES: readonly RegExp[] = [
  /\.includes\(\s*['"`](?:400|401|402|403|404|408|409|429|500|502|503|504|529)['"`]\s*\)/g,
  /\.includes\(\s*['"`][^'"`]*(?:rate.?limit|overloaded|quota|unauthorized|insufficient_quota|too many requests|invalid.?api.?key|api key)[^'"`]*['"`]\s*\)/gi,
  // The regex spelling of the same table. The vocabulary is written tolerantly
  // (`rate[^a-z]{0,3}limit`) because a regex literal in the source may itself contain `.?`
  // or `[-_ ]?` between the words — a detector that only knew the plain spelling would miss
  // exactly the file that had thought about the spelling.
  /\/[^/\n]*(?:rate[^a-z]{0,3}limit|overloaded|quota|unauthorized|too many requests|invalid[^a-z]{0,3}api[^a-z]{0,3}key)[^/\n]*\/[gimsuy]*\s*\.test\(/gi,
];

function countProbes(text: string): number {
  const src = stripComments(text);
  let n = 0;
  for (const re of PROBES) {
    re.lastIndex = 0;
    while (re.exec(src)) n++;
  }
  return n;
}

describe('T10 Step 1b — one prose->class table, and no room for a third', () => {
  it('THE CENSUS: every module that reads provider-error prose is declared, with its role', () => {
    const measured: Record<string, string> = {};
    for (const f of sourceFiles()) {
      if (countProbes(read(f)) === 0) continue;
      measured[f] = PROSE_READERS[f] ?? 'UNDECLARED — a new private prose->class table';
    }
    expect(measured).toEqual(PROSE_READERS);
  });

  it('`ProviderErrorClass` is DECLARED in exactly one place', () => {
    const declarers = sourceFiles().filter((f) => /\btype ProviderErrorClass\b/.test(read(f)));
    expect(declarers).toEqual([TAXONOMY_MODULE]);
  });

  it('both surviving `classifyError` wrappers delegate to the table — neither re-derives', () => {
    const definers = sourceFiles().filter((f) => /function classifyError\s*\(/.test(stripComments(read(f))));
    expect(definers.sort()).toEqual(SANCTIONED_WRAPPERS.map((w) => w.module).sort());
    for (const { module, delegatesTo } of SANCTIONED_WRAPPERS) {
      expect(stripComments(read(module)), `${module} does not delegate`).toMatch(delegatesTo);
    }
  });

  it('the NARROWER asks the table BEFORE it looks at any words', () => {
    // Order matters and it is checkable because both sides are in ONE file — the engine
    // corpus's concatenation-order trap does not apply here (see `engine-sources.ts`).
    // `classifiers/provider.ts` may only narrow a verdict the table already reached; if a
    // probe ever ran first, the file would be deciding a class from prose again.
    const src = stripComments(read('agent/v2/classifiers/provider.ts'));
    const call = src.indexOf('classifyProviderErrorText(');
    let firstProbe = Infinity;
    for (const re of PROBES) {
      re.lastIndex = 0;
      const m = re.exec(src);
      if (m) firstProbe = Math.min(firstProbe, m.index);
    }
    expect(call, 'the narrower never calls the table').toBeGreaterThan(-1);
    expect(firstProbe, 'the narrower has no probes — this clause is measuring nothing').toBeLessThan(Infinity);
    expect(call).toBeLessThan(firstProbe);
  });

  it('NON-VACUITY: the single source still gets the incident right', () => {
    // The census could pass over a table that had stopped working. One control, driving the
    // REAL table on the string that produced the incident. The full behavioural suite is
    // `agent/__tests__/provider-error-classification.test.ts` — cited, not restated.
    expect(classifyProviderErrorText('prompt is too long: 204015 tokens > 200000 maximum').class)
      .not.toBe('auth');
    expect(classifyProviderErrorText('You exceeded your current quota, please check your plan and billing details').class)
      .toBe('quota');
  });
});

describe('T10 Step 1b — the walk bites', () => {
  it('PLANTED FAULT: a fresh private table in a new module is caught', () => {
    // Verbatim shape of what PHASE-4 T5 deleted five copies of.
    const thirdTable = [
      'function classifyIt(msg: string): string {',
      "  const lower = msg.toLowerCase();",
      "  if (lower.includes('401')) return 'auth';",
      "  if (lower.includes('429')) return 'rate_limit';",
      "  if (lower.includes('overloaded')) return 'overloaded';",
      '  return \'unknown\';',
      '}',
    ].join('\n');
    expect(countProbes(thirdTable)).toBe(3);
  });

  it('PLANTED FAULT: the regex spelling of the same table is caught too', () => {
    expect(countProbes("if (/rate.?limit/i.test(msg)) return 'rate_limit';")).toBe(1);
  });

  it('a module that CALLS the table is not a table', () => {
    expect(countProbes("const cls = classifyProviderErrorText(msg).class; if (cls === 'rate_limit') return 1;")).toBe(0);
    expect(countProbes("if (err.status === 429) return 'rate_limit';")).toBe(0);
  });

  it('SELF-TEST: prose describing a probe is not a probe', () => {
    expect(countProbes("// this used to be lower.includes('401')")).toBe(0);
    // POSITIVE CONTROL: the stripper does not blank real code.
    expect(countProbes("if (lower.includes('401')) return 'auth'; // the defect")).toBe(1);
  });
});
