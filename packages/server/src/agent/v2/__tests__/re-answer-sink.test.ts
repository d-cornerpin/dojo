// ════════════════════════════════════════════════════════════════════════════════════════
// THE RE-ANSWER DETECTOR'S DURABLE SINK — PHASE-3 T7 Step 2 (the quiet window opens here).
//
// ── WHY THIS EXISTS (measured at T7's own HEAD, not inherited) ──────────────────────────
// The strip of the SETTLED_HINT, the settled-HOLD carve-outs and the cross-conversation
// echo ROWS is gated on the log-only detector staying quiet for 7 calendar days (research
// 18 §open-1 item 2, pre-adjudicated). The detector has written its findings to
// `~/.dojo/logs/dojo.log` since 2026-07-10. `logger.ts` rotates that file at 10MB keeping
// ONE backup; re-derived at 2026-08-01T06:55Z by reading the first and last record of each:
//
//   dojo.log.1  19,522,717 bytes  06:51:12.869Z → 06:52:14.145Z   1m 01s
//   dojo.log     6,635,551 bytes  06:52:14.124Z → 06:55:27.542Z   3m 13s
//                                 ──────────────────────────────────────
//                                 total retained history           4m 15s
//
// A seven-day window cannot be read out of four minutes of history — and it fails toward
// the answer that licenses a deletion, because an empty `grep` looks exactly like a quiet
// week (roadmap #15).
//
// ── WHAT THE WINDOW NEEDS THAT T4's SINK DID NOT HAVE ──────────────────────────────────
// A DENOMINATOR INSIDE THE DURABLE FILE. T4's sink writes divergences only and sends its
// heartbeat to the rotating log, so T6 had to add a kit route just to learn whether the
// validator had run at all. This sink writes a `heartbeat` record on a process's first
// check and every 20 after it, so the file answers "how many replies were examined"
// without a live instrument — clause 3 is that property.
//
// Every clause below was RED before `recordReAnswerCheck` existed.
// ════════════════════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';

import {
  recordReAnswerCheck,
  readReAnswerSink,
  reAnswerSinkPath,
  reAnswerSinkFailures,
  reAnswerCounters,
  __resetReAnswerSink,
  HEARTBEAT_EVERY,
  RE_ANSWER_SINK_FILENAME,
} from '../re-answer-sink.js';

const REAL_HOME = process.env.HOME;
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-reanswer-sink-'));

beforeEach(() => {
  process.env.HOME = SCRATCH;
  __resetReAnswerSink();
  const p = reAnswerSinkPath();
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
});

afterAll(() => {
  process.env.HOME = REAL_HOME;
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

const check = (over: Partial<Parameters<typeof recordReAnswerCheck>[0]> = {}) =>
  recordReAnswerCheck({
    agentId: 'kevin', turnNumber: 41, convKey: 'conv-a', match: null, replyChars: 400, ...over,
  });

const MATCH = { conversationId: 'conv-b', similarity: 0.72, snippet: 'the same answer again' };

describe('the re-answer detector writes a durable window', () => {
  it('1. a FIRING lands one JSON line on disk, with what fired and how close it was', () => {
    check({ match: MATCH });
    const recs = readReAnswerSink();
    const fires = recs.filter((r) => r.kind === 'fire');
    expect(fires).toHaveLength(1);
    expect(fires[0].matchConv).toBe('conv-b');
    expect(fires[0].similarity).toBe(0.72);
    expect(fires[0].agentId).toBe('kevin');
    expect(fires[0].convKey).toBe('conv-a');
    expect(fires[0].fired).toBe(1);
  });

  it('2. a QUIET week is zero fire records — the file is not a log of everything', () => {
    for (let i = 0; i < HEARTBEAT_EVERY - 1; i++) check();
    expect(readReAnswerSink().filter((r) => r.kind === 'fire')).toHaveLength(0);
    expect(reAnswerCounters()).toEqual({ checked: HEARTBEAT_EVERY - 1, fired: 0 });
  });

  it('3. THE DENOMINATOR IS IN THE FILE: quiet is distinguishable from never-ran', () => {
    // The clause this sink exists for. After one check the file already says the detector
    // ran; after HEARTBEAT_EVERY it says how many replies it examined. Nothing live is
    // consulted — on day 7 the file alone answers both questions.
    check();
    const first = readReAnswerSink();
    expect(first).toHaveLength(1);
    expect(first[0].kind).toBe('heartbeat');
    expect(first[0].checked).toBe(1);

    for (let i = 1; i < HEARTBEAT_EVERY; i++) check();
    const recs = readReAnswerSink();
    expect(recs).toHaveLength(2);
    expect(recs[1].checked).toBe(HEARTBEAT_EVERY);
    expect(recs[1].fired).toBe(0);
  });

  it('4. an ABSENT file is not a quiet week — it reads as nothing measured', () => {
    expect(fs.existsSync(reAnswerSinkPath())).toBe(false);
    expect(readReAnswerSink()).toEqual([]);
    expect(reAnswerCounters().checked).toBe(0);
  });

  it('5. records carry the pid, so counters are never summed across builds', () => {
    check({ match: MATCH });
    expect(readReAnswerSink()[0].pid).toBe(process.pid);
  });

  it('6. a torn last line loses that line, never the window', () => {
    check({ match: MATCH });
    fs.appendFileSync(reAnswerSinkPath(), '{"kind":"fire",  ', 'utf8');
    expect(readReAnswerSink()).toHaveLength(1);
  });

  it('7. it is EXEMPT FROM ROTATION — logger.ts rotates dojo.log and names nothing else', () => {
    const loggerSrc = fs.readFileSync(path.join(process.cwd(), 'src/logger.ts'), 'utf8');
    const rotate = loggerSrc.slice(
      loggerSrc.indexOf('function rotateIfNeeded'),
      loggerSrc.indexOf('function scheduleFlush'),
    );
    expect(rotate.length).toBeGreaterThan(100);          // vacuity guard on the slice
    expect(rotate).toContain('LOG_FILE');
    expect(loggerSrc).not.toContain('re-answer');
    expect(path.basename(reAnswerSinkPath())).toBe(RE_ANSWER_SINK_FILENAME);
    expect(reAnswerSinkPath()).not.toContain('dojo.log');
  });

  it('8. a sink that cannot be written is COUNTED, never silently swallowed', () => {
    // A directory where the file should be: the append must fail. Silence here recreates
    // the exact failure this file exists to fix — an empty window read on day 7 as "quiet"
    // when it really means "the writer never worked", and that reading licenses a deletion.
    fs.mkdirSync(reAnswerSinkPath(), { recursive: true });
    const before = reAnswerSinkFailures();
    check({ match: MATCH });
    expect(reAnswerSinkFailures()).toBe(before + 1);
    fs.rmSync(reAnswerSinkPath(), { recursive: true, force: true });
  });

  it('9. the detector is still LOG-ONLY: recording changes no behaviour', () => {
    // The window measures the build as it runs. A sink that could alter the turn would be
    // measuring itself. `recordReAnswerCheck` returns void, and the call site (loop.ts)
    // neither branches on it nor passes it anywhere.
    expect(check({ match: MATCH })).toBeUndefined();
    const loop = fs.readFileSync(path.join(process.cwd(), 'src/agent/v2/loop.ts'), 'utf8');
    const site = loop.slice(loop.indexOf('recordReAnswerCheck({'));
    expect(site.length).toBeGreaterThan(100);            // vacuity guard on the slice
    expect(site.startsWith('recordReAnswerCheck({')).toBe(true);
    // never assigned, never awaited, never tested
    expect(loop).not.toMatch(/=\s*recordReAnswerCheck/);
    expect(loop).not.toMatch(/if\s*\(\s*recordReAnswerCheck/);
    expect(loop).not.toMatch(/await\s+recordReAnswerCheck/);
  });

  it('10. the header carries the READ commands for day 7', () => {
    // A window nobody can read is a window nobody will read. The four commands live with
    // the writer, the way T5's do.
    const src = fs.readFileSync(path.join(process.cwd(), 'src/agent/v2/re-answer-sink.ts'), 'utf8');
    expect(src).toContain(RE_ANSWER_SINK_FILENAME);
    expect(src).toContain('grep -c');
    expect(src).toContain('jq');
    expect(src).toContain('#15');
  });
});
