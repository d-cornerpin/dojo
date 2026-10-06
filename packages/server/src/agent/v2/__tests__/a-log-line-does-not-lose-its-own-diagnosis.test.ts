// t113 B3 (t110 §4.7, C/L3) — A LOG LINE DOES NOT LOSE ITS OWN DIAGNOSIS.
//
// ── THE DEFECT, AND THE CORRECTION TO THE COUNT IT WAS HANDED UP WITH ──
//
// `logger.<level>(message, meta, agentId)` writes `message` FIRST. So an unbounded string
// interpolated into that first argument pushes everything after it — the structured fields that
// say WHICH class of failure this was — past whatever the reader's log view truncates at. A
// provider error message is exactly the wrong thing to put there unbounded: some providers echo
// the whole offending prompt back, so the one line a reader finds first when a turn died can
// consist entirely of the thing that died and none of the reasons.
//
// t110 handed this up as "five sites logging an untruncated `error.message`" in `agent/v2/**`.
// Re-derived at this head (G11), and the COUNT IS OF THE WRONG POPULATION — the honest figure is
// different in kind, not just in size. There are FIVE logger calls in non-test `agent/v2`
// whose message argument is a template literal with an interpolation, which is presumably what
// was counted. Only TWO of them interpolate an unbounded error message:
//
//   recovery.ts:381   `v2: context overflow detected — ${message}`     UNBOUNDED  ← fixed
//   recovery.ts:750   `v2 agent loop failed: ${message}`               UNBOUNDED  ← fixed
//   delivery-outcome.ts:91   `${where}`                                a code, bounded by its enum
//   call-llm/model-call.ts:400     `${modelId}` / `${fallback.modelId}`  ids
//   call-llm/model-selection.ts:79 `${decision.tier}` / `${modelId}`     ids and a method name
//
// The other three are fine and must stay that way: a clause that demanded a `.slice` on every
// interpolated log message would be enforcing something nobody wrote, and would make a model id
// unreadable to save characters that were never at risk. So this file bans the DANGEROUS
// population — an error message in the message position — and leaves bounded values alone.
//
// Command, unit LOGGER CALLS:
//   the walk below, over packages/server/src/agent/v2 minus __tests__
//     -> 5 interpolated message arguments, 0 carrying an unbounded error message
//
// ── AND THE SEVERITY IS LOWER THAN WHEN IT WAS RECORDED, WHICH IS SAID RATHER THAN HIDDEN ──
//
// t110's own note: `report/bounds.ts`'s identity-last ranking plus its `MESSAGE_HEAD_CHARS` head
// slice mean an over-fat message no longer silently loses the account of what happened in the
// REPORT path — it keeps its first ~200 characters in front of the marker. So this is a sweep at
// the source rather than a load-bearing repair, and 200 here is not a new number: it is the
// convention `recovery.ts` already applies to a message in a log at `:608` and `:690`.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const V2 = path.join(__dirname, '..');

/** Comments blanked, length kept, so prose describing a log line is never counted as one (G4). */
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(p);
  return e.isFile() && p.endsWith('.ts') ? [p] : [];
});

/**
 * A logger call whose MESSAGE argument is a template literal carrying an interpolation, with the
 * interpolated expressions captured.
 *
 * A PURE function of its argument, so §2 can feed it planted shapes.
 */
export function interpolatedLogMessages(source: string): Array<{ line: number; exprs: string[]; text: string }> {
  const text = stripComments(source);
  const out: Array<{ line: number; exprs: string[]; text: string }> = [];
  const re = /logger\.(?:error|warn|info|debug)\(\s*`([^`]*)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = m[1];
    const exprs = [...body.matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1].trim());
    if (exprs.length === 0) continue;
    out.push({ line: text.slice(0, m.index).split('\n').length, exprs, text: body });
  }
  return out;
}

/**
 * THE DANGEROUS POPULATION: an expression that names an ERROR MESSAGE and is not bounded.
 *
 * Keyed on the identifier rather than on "is it a string", because that is the distinction that
 * matters and the one a reader can check. `message`, `errMsg`, `err.message`, `error.message`
 * and friends are unbounded by nature — they come from a provider. `modelId`, `where`,
 * `decision.tier` are values from closed vocabularies.
 */
export function isUnboundedErrorMessage(expr: string): boolean {
  if (/\.slice\(|\.substring\(|\.substr\(/.test(expr)) return false;   // bounded, however spelled
  return /(^|\.)(message|msg|errMsg|errText|errorText|fullErrText)$/i.test(expr)
    || /^(err|error)$/i.test(expr);
}

describe('a log line does not lose its own diagnosis', () => {
  // ── §1 THE CENSUS, both ways: a SIXTH unbounded message reds, wherever it is added ──
  it('no logger call in agent/v2 puts an unbounded error message in the message position', () => {
    const offenders: string[] = [];
    let calls = 0;
    for (const abs of walk(V2)) {
      const source = fs.readFileSync(abs, 'utf8');
      for (const hit of interpolatedLogMessages(source)) {
        calls++;
        for (const expr of hit.exprs) {
          if (isUnboundedErrorMessage(expr)) {
            offenders.push(`${path.relative(V2, abs).split(path.sep).join('/')}:${hit.line} — \${${expr}}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
    // a walk that finds nothing is green and proves nothing. A FLOOR, not a budget: the three
    // bounded-id sites are legitimate and keep this above zero.
    expect(calls, 'the walk still finds the interpolated log messages it is measuring')
      .toBeGreaterThanOrEqual(5);
  });

  it('and the two that were unbounded are bounded at this file\'s own 200', () => {
    const src = stripComments(fs.readFileSync(path.join(V2, 'recovery.ts'), 'utf8'));
    expect(src, 'the overflow line')
      .toMatch(/context overflow detected — \$\{message\.slice\(0, 200\)\}/);
    expect(src, 'the loop-failed line')
      .toMatch(/v2 agent loop failed: \$\{message\.slice\(0, 200\)\}/);
    // the structured half is untouched — the diagnosis still rides beside the message
    expect(src).toMatch(/v2 agent loop failed[^;]*\{ agentId, code, cause \}/);
  });

  // ── §2 THE CLASSIFIER'S OWN CONTROLS ──
  // The rule's whole value is in WHICH population it refuses, so both directions are planted
  // rather than trusted. Without these, narrowing the regex to nothing would pass §1 silently.
  describe('the classifier', () => {
    it('catches an unbounded error message, however it is spelled', () => {
      for (const expr of ['message', 'msg', 'err.message', 'error.message', 'fullErrText', 'err']) {
        expect(isUnboundedErrorMessage(expr), expr).toBe(true);
      }
    });

    it('accepts a BOUNDED one, however it is bounded', () => {
      for (const expr of ['message.slice(0, 200)', 'err.message.substring(0, 80)']) {
        expect(isUnboundedErrorMessage(expr), expr).toBe(false);
      }
    });

    it('leaves the three legitimate id sites alone — the half that keeps this honest', () => {
      // A rule that demanded a slice on every interpolation would make a model id unreadable to
      // save characters that were never at risk. These are the live expressions.
      for (const expr of ['modelId', 'fallback.modelId', 'where', 'decision.tier', 'decision.method']) {
        expect(isUnboundedErrorMessage(expr), expr).toBe(false);
      }
    });

    it('reads the interpolations out of a real call, and ignores a bare message', () => {
      const found = interpolatedLogMessages(
        "logger.error(`a failed: ${err.message}`, { a: 1 });\nlogger.info('no interpolation here', {});",
      );
      expect(found).toHaveLength(1);
      expect(found[0].exprs).toEqual(['err.message']);
    });

    it('does not read PROSE about a log line as a log line', () => {
      expect(interpolatedLogMessages('// logger.error(`boom: ${message}`)\nconst x = 1;')).toEqual([]);
    });

    it('and keeps line numbers, so a finding points at the right line', () => {
      const src = '/* a\nb */\nlogger.warn(`x: ${message}`, {});';
      expect(interpolatedLogMessages(src)[0].line).toBe(3);
    });
  });
});
