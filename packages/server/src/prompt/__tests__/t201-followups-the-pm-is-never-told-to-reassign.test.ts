// ════════════════════════════════════════════════════════════════════════════════════════
// t201 follow-up 1 — NOTHING THE PM READS TELLS IT TO REASSIGN (owner decision 1: the PM NEVER
// moves a task; it keeps the assignee working and escalates to the owner).
//
// t193 took the verb away (`PM_ALLOWED_WORK_OPS` has no `work_update:reassign`, and
// `checkMove` refuses the PM by identity). The words did not follow: the shipped PM soul still
// said "Reassign it", "hand it to someone else with work_update(action="reassign" …)" and
// "call work_update(action="reassign" …) if someone else can take it", and the executor's
// refusal message for a PM listed `work_update(action="reassign")` as one of the PM's own
// overseer verbs. A prompt that orders a refused call is how a validator gets confused.
//
// THE CENSUS (read from source, comments blanked, so prose ABOUT the rule is never a hit):
//   A. the shipped souls and every template: no `action="reassign"`, and the PM soul never
//      offers moving a task as something to do;
//   B. the PM soul says the positive rule: keep the assignee working, escalate;
//   C. the executor's PM-refusal message does not list reassign among the PM's verbs;
//   D. the PM's own prompt strings (tracker/pm-agent.ts): every mention of reassigning is a
//      prohibition.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '..', '..');
const TEMPLATES = path.resolve(SRC, '..', '..', '..', 'templates');
const read = (p: string): string => fs.readFileSync(p, 'utf8');
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

const SOUL = read(path.join(TEMPLATES, 'PM-SOUL.md'));

describe('A. no shipped template orders a reassignment', () => {
  const files = fs.readdirSync(TEMPLATES).filter((f) => f.endsWith('.md'));
  it('the census sees the templates', () => { expect(files).toContain('PM-SOUL.md'); });

  for (const f of files) {
    it(`${f} never tells its reader to call work_update(action="reassign")`, () => {
      expect(read(path.join(TEMPLATES, f))).not.toMatch(/action\s*=\s*["']reassign["']/);
    });
  }

  it('the PM soul never offers moving a task as a remedy', () => {
    expect(SOUL).not.toMatch(/\bReassign it\b/);
    expect(SOUL).not.toMatch(/hand it to someone else/i);
    expect(SOUL).not.toMatch(/reassign and retask are/i);
    expect(SOUL).not.toMatch(/if someone else can take it/i);
  });
});

describe('B. the PM soul states the rule it was given', () => {
  it('keeps the assignee working', () => {
    expect(SOUL).toMatch(/keep the assignee working/i);
  });
  it('escalates, and says it never moves a task', () => {
    expect(SOUL).toMatch(/never (move|reassign)/i);
    expect(SOUL).toMatch(/escalate/i);
  });
});

describe('C. the executor does not list reassign among the PM\'s own verbs', () => {
  it('the PM refusal message names no reassign verb', () => {
    const src = stripComments(read(path.join(SRC, 'agent/tools/index.ts')));
    const at = src.indexOf('You are the project manager (overseer)');
    expect(at, 'the PM refusal message is still in the executor').toBeGreaterThan(-1);
    const message = src.slice(at, src.indexOf('isError', at));
    expect(message).not.toMatch(/reassign/i);
  });
});

describe('D. every mention of reassigning in the PM\'s own prompt strings is a prohibition', () => {
  it('pm-agent.ts', () => {
    const lines = stripComments(read(path.join(SRC, 'tracker/pm-agent.ts'))).split('\n')
      .filter((l) => /reassign/i.test(l));
    expect(lines.length, 'the census sees the PM prompt strings').toBeGreaterThan(0);
    for (const l of lines) {
      expect(l, 'a line of PM prompt text mentions reassigning without forbidding it').toMatch(
        /(cannot|can't|do not|don't|never|NOT|no reassign|not its call|is not offered)[^.]{0,80}reassign|reassign[^.]{0,60}(is not|never|NOT)/i,
      );
    }
  });
});
