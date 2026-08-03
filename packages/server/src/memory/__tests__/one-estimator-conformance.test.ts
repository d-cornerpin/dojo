// ════════════════════════════════════════════════════════════════════════════════════════
// PHASE-3 T2 — "the six estimators are one", asserted whole-tree, by file.
//
// This is the gate PHASE-3 T9's exit criterion names. It exists because research 06 counted
// FOUR token estimators (assembler / provider / receipt) and §T0-C found SIX plus a SQL
// dialect: collapsing only research's four would have left `vault/maintenance.ts` and
// `healer/healer-agent.ts` alive — the identical shape as PHASE-1's third message store,
// which is the disease this overhaul exists to delete.
//
// The six, at `81fc6b7`, each named here so a re-growth is a NAMED failure and not a
// silently-passing grep:
//
//   1  memory/store.ts:44-45            /4     the live default (via message-store.ts:227)
//   2  agent/model.ts:2289,:2294,:2297  /3.5   the Anthropic transport
//   3  agent/model.ts:1271-2,:1302,:1315,:1327,:1347-8  /3   the OpenAI transport
//   4  agent/v2/receipt.ts:88           /4     an independent re-declaration of #1
//   5  vault/maintenance.ts:565         /3     the Dreamer's archive batching
//   6  healer/healer-agent.ts:44        /3     the Healer's batch budget
//
// NOT estimators of stored bytes, and DELIBERATELY not folded in (§T0-C's own list) — a
// "one estimator" rule that ate these would make the phase look finished while breaking two
// features, so this file pins them as legitimate survivors rather than leaving the next
// reader to re-litigate them:
//
//   agent/model.ts:1682-1683                usage FALLBACK when a provider reports none
//   providers/anthropic-sdk.ts:365,:368     usage FALLBACK, same job
//   agent/tools/cat/recall.ts               recall-budget accounting (was agent/tools.ts)
//   agent/tools/index.ts                    result-cap accounting (was agent/tools.ts)
//
// The grep is whole-tree (`packages/**/src`, every `.ts` that is not a test) and it looks
// for the SHAPE of an estimator — a division of a length by a small constant — not for the
// name `estimateTokens`, because a re-growth would not reuse the name.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../../..');           // …/dojo
const ROOTS = ['packages/server/src', 'packages/shared/src', 'packages/dashboard/src'];

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '__tests__') continue;
      walk(p, out);
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') && !e.name.endsWith('.test.ts')) {
      out.push(p);
    }
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * `x.length / 4`, `chars / 3.5`, `content.length/3` — the shape, whatever it is called.
 *
 * The `embedding|buf|byte` exclusion is NOT a loosening and it was earned on the first run:
 * `vault/store.ts:643,:697,:705,:752` divide a Float32 buffer's byte length by 4 to get a
 * DIMENSION COUNT. That is arithmetic about bytes, not a claim about tokens, and folding it
 * into "one estimator" would have been the mirror image of the mistake this file exists to
 * catch. Anything a reader could mistake for a token estimate stays in scope.
 */
const DIVISION_SHAPE = /(?:\w+\.)?(?:length|chars|charCount)\s*\/\s*(?:3(?:\.5)?|4)\b/i;
const NOT_A_TOKEN_COUNT = /embedding|buf|byte/i;

/** Lines that look like a token estimator, 1-based, so a failure names the line. */
function estimatorLines(src: string): Array<{ n: number; line: string }> {
  return stripComments(src)
    .split('\n')
    .map((line, i) => ({ n: i + 1, line }))
    .filter(({ line }) => DIVISION_SHAPE.test(line) && !NOT_A_TOKEN_COUNT.test(line));
}
const DIVISION_ESTIMATOR = { test: (src: string) => estimatorLines(src).length > 0 };
/** A named chars-per-token constant re-declared locally instead of imported. */
const LOCAL_CHARS_PER_TOKEN = /^\s*(?:export\s+)?const\s+CHARS_PER_TOKEN\s*=/m;

// The ONE place a division by the divisor is allowed to appear.
const CANONICAL = 'packages/server/src/memory/budget.ts';

// Positive survivors, with the reason each is a different job (§T0-C).
const DECLARED_SURVIVORS: Array<{ file: string; why: string }> = [
  { file: 'packages/server/src/agent/model.ts', why: 'usage FALLBACK at :1682-1683 — only when a provider reports no usage at all' },
  { file: 'packages/server/src/providers/anthropic-sdk.ts', why: 'usage FALLBACK at :365,:368 — same job as above' },
  // PHASE-5 T4 (the split's last move): `agent/tools.ts` is DELETED and the
  // survivor FOLLOWED THE CODE for the second time — `applyMaxResultTokensCap`
  // moved to the executor's new home with the executor that calls it. This
  // walk caught the stale entry itself ("packages/server/src/agent/tools.ts
  // vanished — re-derive before deleting it from this list"), which is the
  // clause working: a declared survivor that quietly disappears is how a list
  // rots into lies.
  { file: 'packages/server/src/agent/tools/index.ts', why: 'result-cap accounting in applyMaxResultTokensCap — a per-tool spend ledger, not a prompt cost' },
  // PHASE-5 T4 (the toolbox split): the recall-budget half of the entry above
  // MOVED with the handlers it belongs to. Two of that entry's three sites were
  // `recall_recent_thread` and `history_search` billing their own emitted output
  // against the per-turn recall budget; those bodies now live in
  // `agent/tools/cat/recall.ts` and the third (the result cap) stayed. Same job,
  // same reason, new file — the survivor list follows the code rather than the
  // code being reshaped to fit the list.
  { file: 'packages/server/src/agent/tools/cat/recall.ts', why: 'recall-budget accounting (RC-3) — a per-tool spend ledger billed against the turn, not a prompt cost' },
];

describe('ONE estimator, whole tree (research 06 requirement A2)', () => {
  const files = ROOTS.flatMap((r) => walk(path.join(REPO, r))).map((f) => path.relative(REPO, f));

  it('scans a real tree, not an empty one (vacuity guard)', () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files).toContain(CANONICAL);
  });

  it('has exactly ONE division-by-divisor estimator outside the declared survivors', () => {
    const offenders = files
      .filter((f) => f !== CANONICAL)
      .filter((f) => !DECLARED_SURVIVORS.some((s) => s.file === f))
      .filter((f) => DIVISION_ESTIMATOR.test(fs.readFileSync(path.join(REPO, f), 'utf8')));
    expect(
      offenders,
      'a token estimator re-grew. The six of §T0-C were collapsed into memory/budget.ts at ' +
      'PHASE-3 T2; a new one here means the tree has two answers to "what does this text cost" again. ' +
      'If the new site is a genuinely different job, add it to DECLARED_SURVIVORS with its reason.',
    ).toEqual([]);
  });

  it('names all SIX of the collapsed sites and proves each stopped declaring its own', () => {
    const collapsed = [
      'packages/server/src/memory/store.ts',
      'packages/server/src/agent/v2/receipt.ts',
      'packages/server/src/vault/maintenance.ts',
      'packages/server/src/healer/healer-agent.ts',
    ];
    for (const f of collapsed) {
      const src = stripComments(fs.readFileSync(path.join(REPO, f), 'utf8'));
      expect(DIVISION_ESTIMATOR.test(src), `${f} still divides a length by a token divisor`).toBe(false);
      expect(LOCAL_CHARS_PER_TOKEN.test(src), `${f} re-declares CHARS_PER_TOKEN locally`).toBe(false);
      expect(src.includes("from '"), `${f} should import the estimator, not own one`).toBe(true);
    }
    // model.ts carries BOTH transports' former forks plus a declared survivor, so it is
    // asserted by shape rather than by absence: no /3 and no /3.5 anywhere in it.
    const model = stripComments(fs.readFileSync(path.join(REPO, 'packages/server/src/agent/model.ts'), 'utf8'));
    expect(/\.length\s*\/\s*3(\.5)?\b/.test(model), 'agent/model.ts still carries a /3 or /3.5 fork').toBe(false);
    expect(model.includes("from '../memory/budget.js'"), 'agent/model.ts must import the one estimator').toBe(true);
  });

  it('keeps the declared survivors DECLARED — each still exists and still says why', () => {
    // #15: this asserts PRESENCE, so a survivor that silently disappears is a finding too.
    for (const s of DECLARED_SURVIVORS) {
      expect(fs.existsSync(path.join(REPO, s.file)), `${s.file} vanished — re-derive before deleting it from this list`).toBe(true);
      expect(s.why.length).toBeGreaterThan(20);
    }
  });

  it('has exactly ONE declaration of the threshold, the output reserve and the divisor', () => {
    const declRes: Array<[RegExp, string]> = [
      [/^\s*(?:export\s+)?const\s+CHARS_PER_TOKEN\s*=\s*\d/m, 'CHARS_PER_TOKEN'],
      [/^\s*(?:export\s+)?const\s+OUTPUT_RESERVE_TOKENS\s*=\s*\d/m, 'OUTPUT_RESERVE_TOKENS'],
      [/^\s*(?:export\s+)?const\s+CONTEXT_THRESHOLD\s*=\s*[\d.]/m, 'CONTEXT_THRESHOLD'],
    ];
    for (const [re, name] of declRes) {
      const holders = files.filter((f) => re.test(stripComments(fs.readFileSync(path.join(REPO, f), 'utf8'))));
      expect(holders, `${name} must be declared exactly once, in ${CANONICAL}`).toEqual([CANONICAL]);
    }
  });

  it('TOOL_AND_OUTPUT_RESERVE is GONE — grep-zero, not merely single-sourced (PHASE-3 T4)', () => {
    // This clause REPLACES "TOOL_AND_OUTPUT_RESERVE is declared exactly once", and it is
    // strictly harder to pass. The old clause could only ever ask "is the constant in one
    // place"; T4 measured that the constant was WRONG in a way no amount of single-sourcing
    // fixes — 15,000 is smaller than the primary agent's tool schemas alone (17,502), so
    // the assembler's ceiling sat above the window. The reserve is now COMPUTED per agent
    // per call from the measured payload, so the honest assertion is that the constant
    // does not exist anywhere, in any spelling, including a re-export.
    //
    // requirement preserved: "one number for the tokens the assembler does not control" —
    // owned by `toolAndOutputReserve()` in memory/budget.ts, which no caller can bypass
    // because `contextWindowPolicy` has no signature without its measured inputs.
    // Comments are stripped: the demolition record NAMES the constant it removed (the
    // `requirement preserved:` lines in budget.ts and compaction.ts), which is the
    // convention, not a survivor. What must be zero is CODE that still spells it.
    const offenders = files.filter((f) =>
      /TOOL_AND_OUTPUT_RESERVE/.test(stripComments(fs.readFileSync(path.join(REPO, f), 'utf8'))));
    expect(files.length, 'vacuity guard: the file list is empty').toBeGreaterThan(200);
    expect(offenders, 'TOOL_AND_OUTPUT_RESERVE is back — the reserve is measured now').toEqual([]);
  });

  it('nobody can build a policy without measuring — the reserve has no default', () => {
    // The escape hatch that would quietly re-create the constant is an optional parameter.
    const budget = stripComments(fs.readFileSync(path.join(REPO, CANONICAL), 'utf8'));
    expect(budget).toContain('export function toolAndOutputReserve');
    // `measured` is REQUIRED: no `measured?:` and no `= …` default. The parameter list is
    // sliced to its own closing paren by brace/paren depth — an earlier version of this
    // clause cut at the first `{`, which lands INSIDE the type literal, so it went green
    // over a planted default it never saw. Caught by taking the bite proof.
    const start = budget.indexOf('export function contextWindowPolicy');
    expect(start, 'contextWindowPolicy vanished').toBeGreaterThan(-1);
    const open = budget.indexOf('(', start);
    let depth = 0; let end = open;
    for (let i = open; i < budget.length; i++) {
      const ch = budget[i];
      if (ch === '(' ) depth++;
      else if (ch === ')') { depth--; if (depth === 0) { end = i; break; } }
    }
    const params = budget.slice(open + 1, end);
    expect(params).toContain('measured:');
    expect(params).not.toContain('measured?:');
    expect(params, 'a default here silently re-creates the constant').not.toMatch(/measured\s*:[^,]*=/s);
  });

  it('makes dialect 3 UNSPELLABLE: no caller can hand `token_count` a number', () => {
    // Step 3b (ii). The fix is not a validation, it is the removal of the escape hatch:
    // `tokenCount` left `NewMessage` entirely, so `loop.ts` cannot re-offer the provider's
    // OUTPUT count for the whole turn to a column the budget spends as INPUT cost. A type
    // that cannot express the mistake is the only version of this fix that stays fixed.
    const ms = stripComments(fs.readFileSync(path.join(REPO, 'packages/server/src/memory/message-store.ts'), 'utf8'));
    const iface = ms.slice(ms.indexOf('export interface NewMessage'), ms.indexOf('export interface Persisted'));
    expect(iface.length).toBeGreaterThan(200);                       // vacuity guard
    expect(/^\s*tokenCount\??\s*:/m.test(iface), 'NewMessage accepts a tokenCount again').toBe(false);
    expect(ms.includes('estimateStoredTokens(prepared.content)'), 'the write site must derive it').toBe(true);

    const offenders = files
      .filter((f) => /tokenCount:\s*(?!null)/.test(stripComments(fs.readFileSync(path.join(REPO, f), 'utf8'))))
      .filter((f) => {
        // A `tokenCount:` that PROJECTS a stored row outward is fine; one that feeds an
        // insert is the defect. Scope to the call sites that reach the writer.
        const src = stripComments(fs.readFileSync(path.join(REPO, f), 'utf8'));
        return /insertMessage(IfAbsent)?\(\{[^}]*tokenCount:/s.test(src);
      });
    expect(offenders, 'a caller is passing tokenCount into the message writer again').toEqual([]);
  });

  it('leaves NO literal 0.75 / 0.96 / 0.90 / 0.99 threshold outside the budget module', () => {
    // The four declarations §T0-C found (assembler:26, compaction:209, compaction:529,
    // classifiers/compaction.ts:38-41) all become imports. A bare literal here is how the
    // owner's DECIDED 0.96 quietly becomes two numbers again.
    const THRESHOLD_LITERAL = /(?:contextThreshold|Threshold|threshold)\s*[:=]\s*0\.(?:75|90|96|99)\b/;
    const offenders = files
      .filter((f) => f !== CANONICAL)
      .filter((f) => THRESHOLD_LITERAL.test(stripComments(fs.readFileSync(path.join(REPO, f), 'utf8'))));
    expect(offenders, 'a context threshold literal re-appeared; import it from memory/budget.ts').toEqual([]);
  });
});
