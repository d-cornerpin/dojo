// ════════════════════════════════════════════════════════════════════════════════════════
// THE DURABLE DIVERGENCE SINK — PHASE-3 T5, orchestrator opening rider.
//
// ── WHY THIS EXISTS (measured, not assumed) ─────────────────────────────────────────────
// T4 opened a 7-CALENDAR-DAY detect-only window whose day-7 verdict is read from the
// validator's own log lines. Those lines went to `~/.dojo/logs/dojo.log`, which
// `logger.ts:48-66` rotates at 10MB keeping exactly ONE backup. Re-derived at THIS task's
// HEAD (`ababf11`, 2026-08-01T04:12Z), by command:
//
//   dojo.log.1  19,081,331 bytes  spans 2026-08-01T03:56:01.221Z → 04:00:33.948Z  (4m33s)
//   dojo.log     4,265,426 bytes  spans 2026-08-01T04:00:33.564Z → 04:12:15.073Z (11m42s)
//
// Total retained history at that instant: 16 minutes 14 seconds. Under the heavier traffic
// the rotated file recorded, retention is under FIVE minutes. T4's own 17 day-0 divergence
// lines are already gone — `grep -c ASSEMBLY_VALIDATION_DIVERGENCE` over BOTH files returns
// 0. A 7-day window whose evidence lives in a file with minutes of retention cannot answer
// its own day-7 question.
//
// The in-process counters have the second half of the same problem: `tsx watch` restarts on
// every source save, so they describe the last few minutes of the last build.
//
// ── WHAT THE SINK IS ────────────────────────────────────────────────────────────────────
// `~/.dojo/logs/assembly-validation.jsonl`. Append-only, one JSON object per DIVERGENCE,
// written by the validator itself beside its logger line. Not touched by `logger.ts`'s
// rotation (that function names `dojo.log` and nothing else — clause 6 pins it). Tiny by
// construction: heartbeats and clean calls write NOTHING, so the file's size is the
// incident count, and on a clean week it is empty or absent — which is itself the answer.
//
// Every clause below was RED before `appendDivergenceRecord` existed.
// ════════════════════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// The boundary function dynamically imports the tool-payload measurement, which needs the
// live tools registry and therefore the database. The sink is not that function's subject,
// so the measurement is stubbed to a constant and the REAL boundary code runs.
vi.mock('../../tools/tool-docs.js', () => ({
  measureAgentToolPayloadTokens: async () => 0,
}));

import {
  validateAtProviderBoundary,
  __resetAssemblyValidationCounters,
  ASSEMBLY_VALIDATION_MODE,
  type ValidatedMessage,
} from '../assembly-validation.js';
import {
  assemblyValidationSinkPath,
  appendDivergenceRecord,
  readAssemblyValidationSink,
  assemblyValidationSinkFailures,
  __resetAssemblyValidationSinkFailures,
} from '../assembly-validation-sink.js';

const REAL_HOME = process.env.HOME;
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-sink-'));

function useScratchHome(): void {
  process.env.HOME = SCRATCH;
}

beforeEach(() => {
  useScratchHome();
  __resetAssemblyValidationCounters();
  __resetAssemblyValidationSinkFailures();
  const p = assemblyValidationSinkPath();
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
});

afterAll(() => {
  process.env.HOME = REAL_HOME;
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

const user = (content: string): ValidatedMessage => ({ role: 'user', content });
const asst = (content: string): ValidatedMessage => ({ role: 'assistant', content });

/** Well-formed and small — passes every clause. */
const clean = (): ValidatedMessage[] => [user('what is the plan?'), asst('here it is'), user('go')];

/** Well-formed but far over any sane budget — SIZE divergence, no shape confound. */
const oversized = (): ValidatedMessage[] => [user('x'.repeat(400_000)), asst('y'), user('z')];

async function boundary(messages: ValidatedMessage[], contextWindow = 8_000) {
  return validateAtProviderBoundary({
    agentId: 'kevin',
    modelId: 'deepseek/deepseek-chat',
    messages,
    systemPrompt: 'you are a test',
    contextWindow,
    maxOutputTokens: 4_096,
  });
}

// ════════ 1. the sink exists and captures a real divergence ════════

describe('the durable divergence sink', () => {
  it('1. a divergent call at the provider boundary lands one JSON line on disk', async () => {
    const result = await boundary(oversized());
    expect(result.ok).toBe(false);

    const p = assemblyValidationSinkPath();
    expect(fs.existsSync(p)).toBe(true);

    const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.codes).toContain('budget-exceeded');
    expect(rec.agentId).toBe('kevin');
    expect(rec.overBy).toBeGreaterThan(0);
  });

  it('2. a CLEAN call writes nothing — tiny by construction, so size IS the incident count', async () => {
    const r = await boundary(clean(), 200_000);
    expect(r.ok).toBe(true);
    expect(fs.existsSync(assemblyValidationSinkPath())).toBe(false);
  });

  it('3. it is APPEND-ONLY: a second divergence adds a line and leaves the first byte-identical', async () => {
    await boundary(oversized());
    const first = fs.readFileSync(assemblyValidationSinkPath(), 'utf8');
    await boundary(oversized());
    const both = fs.readFileSync(assemblyValidationSinkPath(), 'utf8');
    expect(both.startsWith(first)).toBe(true);
    expect(both.trim().split('\n')).toHaveLength(2);
  });

  it('4. the record carries what the day-7 read needs, INCLUDING its own denominator', async () => {
    await boundary(oversized());
    const [rec] = readAssemblyValidationSink(assemblyValidationSinkPath());
    // when
    expect(typeof rec.at).toBe('string');
    expect(new Date(rec.at).toString()).not.toBe('Invalid Date');
    // which build/process — the counters reset on every `tsx watch` restart, so a record
    // without its pid cannot be grouped back into a denominator
    expect(typeof rec.pid).toBe('number');
    expect(rec.mode).toBe(ASSEMBLY_VALIDATION_MODE);
    // what diverged, in the two forms the window is read in
    expect(Array.isArray(rec.codes)).toBe(true);
    expect(Array.isArray(rec.violations)).toBe(true);
    expect(rec.violations[0]).toMatch(/budget-exceeded:/);
    // the numbers
    expect(rec.tokenTotal).toBeGreaterThan(rec.budgetTokens);
    expect(rec.messageCount).toBe(3);
    // the rate, not just the incident
    expect(rec.checked).toBeGreaterThanOrEqual(1);
    expect(rec.diverged).toBeGreaterThanOrEqual(1);
  });

  it('5. it SURVIVES a process restart, which the in-process counters deliberately do not', async () => {
    await boundary(oversized());
    // a restart is exactly this: the module counters go to zero, the file does not
    __resetAssemblyValidationCounters();
    await boundary(oversized());
    const recs = readAssemblyValidationSink(assemblyValidationSinkPath());
    expect(recs).toHaveLength(2);
    // and the second record's own denominator restarted at 1 — which is WHY the pid is on
    // the row: `checked` is per-process and must never be summed across processes
    expect(recs[1].checked).toBe(1);
  });

  it('6. it is EXEMPT FROM ROTATION — logger.ts rotates dojo.log and names nothing else', () => {
    const loggerSrc = fs.readFileSync(
      path.join(process.cwd(), 'src/logger.ts'), 'utf8',
    );
    const rotate = loggerSrc.slice(
      loggerSrc.indexOf('function rotateIfNeeded'),
      loggerSrc.indexOf('function scheduleFlush'),
    );
    expect(rotate.length).toBeGreaterThan(100);          // vacuity guard on the slice
    expect(rotate).toContain('LOG_FILE');
    expect(loggerSrc).not.toContain('assembly-validation');
    // and the sink is a different file from the one that rotates
    expect(path.basename(assemblyValidationSinkPath())).toBe('assembly-validation.jsonl');
    expect(assemblyValidationSinkPath()).not.toContain('dojo.log');
  });

  it('7. a sink that cannot be written is COUNTED, never silently swallowed', () => {
    // A directory where the file should be: the append must fail. Silence here would
    // recreate the exact failure the sink exists to fix — an empty file being read on day 7
    // as "a clean week" when it is really "the writer never worked".
    const p = assemblyValidationSinkPath();
    fs.mkdirSync(p, { recursive: true });
    const before = assemblyValidationSinkFailures();
    appendDivergenceRecord({
      at: new Date().toISOString(), pid: process.pid, mode: 'detect',
      agentId: 'kevin', modelId: 'm', codes: ['budget-exceeded'], violations: ['x'],
      tokenTotal: 2, budgetTokens: 1, overBy: 1, messageCount: 1, checked: 1, diverged: 1,
    });
    expect(assemblyValidationSinkFailures()).toBe(before + 1);
    fs.rmSync(p, { recursive: true, force: true });
  });

  it('8. the day-7 read instructions point at the SINK, and say why not the rotating log', () => {
    // The validator's header must NAME the sink — a worker reading the flip's own module
    // and finding only `dojo.log` re-derives the retention trap from scratch.
    const validator = fs.readFileSync(
      path.join(process.cwd(), 'src/memory/assembly-validation.ts'), 'utf8',
    );
    const header = validator.slice(0, validator.indexOf('let checkedCalls'));
    expect(header).toContain('assembly-validation.jsonl');
    expect(header).toMatch(/rotat/i);
    expect(header).toContain('assembly-validation-sink.ts');

    // and the sink module carries the actual commands, including the heartbeat one — the
    // sink alone cannot distinguish a clean week from a dead writer (#15).
    const sink = fs.readFileSync(
      path.join(process.cwd(), 'src/memory/assembly-validation-sink.ts'), 'utf8',
    );
    const sinkHeader = sink.slice(0, sink.indexOf('import fs'));
    expect(sinkHeader).toContain('wc -l ~/.dojo/logs/assembly-validation.jsonl');
    expect(sinkHeader).toContain('ASSEMBLY_VALIDATION_HEARTBEAT');
    expect(sinkHeader).toMatch(/rotat/i);
  });
});
