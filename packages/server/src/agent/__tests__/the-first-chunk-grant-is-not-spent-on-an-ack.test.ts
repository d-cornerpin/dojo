// ════════════════════════════════════════════════════════════════════════════════════════
// T72b claim 2 — THE FIRST-CHUNK GRANT IS NOT SPENT ON AN ACK FRAME.
// ════════════════════════════════════════════════════════════════════════════════════════
//
// ── THE CLAIM (owner's DS4-server agent) ────────────────────────────────────────────────
// "Heavy subsequent turns need 190s+ before the first token. Something gave up at ~166s and
//  auto-retried from cold; the retry cannibalises." With `first_chunk_timeout_ms = 200000`.
//
// ── THE KILLER, NAMED ───────────────────────────────────────────────────────────────────
// `makeStreamWatchdog` has ONE timer, and `bump()` re-arms it with `idleMs` — always,
// starting with the very first bump. In the OpenAI-compatible consume loop, `watchdog.bump()`
// is the FIRST statement in the body, before `if (!delta) continue` and before any look at
// what the frame carried (`model.ts:1601-1609`). So the first SSE frame of ANY kind spends
// the whole first-chunk grant:
//
//   * `delta: {"role":"assistant"}` — the content-free ack most OpenAI-compatible servers
//     (llama.cpp, vLLM, LM Studio, LiteLLM) emit the moment generation is queued;
//   * a zero-choice frame;
//   * the `stream_options.include_usage` frame.
//
// After that the bound is `idleMs`, which nobody raised because nothing about a long PREFILL
// suggests you should. The arithmetic of the owner's 166 s is then exact and unremarkable:
//
//     abort_at = t(first ack frame) + idleMs  =  106 s + 60 s  =  166 s
//
// while `first_chunk_timeout_ms = 200000` sat there, never consulted again. `elapsedMs()` is
// measured from ARM time, so a log line reading ~166000 ms under a 200 s declared bound is
// itself the proof that the idle bound fired, not the first-chunk bound.
//
// ── THIS IS T64b's OWN CONTRACT, VIOLATED BY ITS OWN IMPLEMENTATION ─────────────────────
// `stream-patience.ts` states the rule in the module that owns it:
//
//   "Declaring that a machine may think for six minutes before it speaks says nothing about
//    how long it may go silent ONCE IT HAS PROVEN IT CAN EMIT."
//
// An empty `delta: {"role":"assistant"}` is not proof that anything can emit. It is proof
// that the socket is open, which was never in doubt.
//
// ── AND THEN THE RETRY CANNIBALISES ─────────────────────────────────────────────────────
// Both bounds threw the SAME phrase, so a first-chunk timeout was indistinguishable from a
// mid-answer stall and collected T65b's one same-model retry. The retry re-dials cold with
// the identical messages (`model-call.ts:92-133`), so the local box restarts the whole
// prefill it was 80% through — and dies at the same bound again, having burned twice the
// wall clock and twice the electricity to produce one error.
//
// A provider that DECLARED its first-chunk patience and then blew through it has already
// told us how long it needed and failed to deliver inside it. Retrying that from scratch is
// not resilience, it is the same experiment run again. The honest thing is the error.
// Providers that declared nothing keep today's behaviour exactly — that is the control.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import {
  makeStreamWatchdog,
  streamTimeoutPhrase,
  STREAM_IDLE_TIMEOUT_ERROR,
  STREAM_FIRST_CHUNK_TIMEOUT_ERROR,
} from '../model.js';
import { resolveStreamPatience, STREAM_FIRST_CHUNK_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS } from '../stream-patience.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Short bounds, same SHAPE as the owner's: a generous first-chunk grant and a much smaller
// idle bound. 400 vs 80 is his 200 s vs 60 s, scaled so the test is fast.
const FIRST_CHUNK = 400;
const IDLE = 80;

describe('T72b/2 — a content-free frame does not spend the first-chunk grant', () => {
  it('THE DEFECT: an ack frame must not collapse the first-chunk bound to the idle bound', async () => {
    const w = makeStreamWatchdog(undefined, FIRST_CHUNK, IDLE);
    // The ack frame: `delta: {"role":"assistant"}`. The consume loop bumps on it.
    w.bump();
    // Well past the idle bound, nowhere near the declared first-chunk bound. The machine is
    // still doing prompt processing, which is exactly what the owner bought patience for.
    await sleep(IDLE * 2.5);

    // RED at HEAD: `bump: () => arm(idleMs)` re-armed at 80ms, so this is already dead.
    expect(w.timedOut()).toBe(false);
    w.finish();
  });

  it('the grant is still BOUNDED — the first-chunk bound itself does fire', async () => {
    const w = makeStreamWatchdog(undefined, IDLE * 2, IDLE);
    w.bump();
    w.bump();
    await sleep(IDLE * 4);
    // Bumping forever must not buy unlimited time: the 602-second hang the watchdog was
    // built for (DOJO-ISSUES-LOG 2026-07-10) stays caught.
    expect(w.timedOut()).toBe(true);
    expect(w.firstChunkTimedOut()).toBe(true);
    w.finish();
  });

  it('once content has actually arrived, the idle bound takes over (the dead-connection detector survives)', async () => {
    const w = makeStreamWatchdog(undefined, FIRST_CHUNK, IDLE);
    w.bump();
    w.contentStarted(); // a real token — reasoning or text — proved it can emit
    await sleep(IDLE * 2.5);

    expect(w.timedOut()).toBe(true);
    // …and it was the IDLE bound that fired, not the first-chunk one.
    expect(w.firstChunkTimedOut()).toBe(false);
    w.finish();
  });

  it('CONTROL — a healthy stream that keeps emitting is never cut', async () => {
    const w = makeStreamWatchdog(undefined, FIRST_CHUNK, IDLE);
    w.bump();
    w.contentStarted();
    for (let i = 0; i < 6; i++) {
      await sleep(IDLE / 2);
      w.bump();
    }
    expect(w.timedOut()).toBe(false);
    w.finish();
  });

  it('CONTROL — a user stop is still not a watchdog timeout', async () => {
    const external = new AbortController();
    const w = makeStreamWatchdog(external.signal, FIRST_CHUNK, IDLE);
    external.abort();
    await sleep(10);
    expect(w.signal.aborted).toBe(true);
    expect(w.timedOut()).toBe(false);
    expect(w.firstChunkTimedOut()).toBe(false);
    w.finish();
  });
});

describe('T72b/2 — a declared first-chunk timeout does not collect the cold-restart retry', () => {
  const declared = resolveStreamPatience({ firstChunkTimeoutMs: 600_000, streamIdleTimeoutMs: null });
  const undeclared = resolveStreamPatience({ firstChunkTimeoutMs: null, streamIdleTimeoutMs: null });

  it('resolveStreamPatience reports whether the first-chunk bound was DECLARED', () => {
    expect(declared.firstChunkDeclared).toBe(true);
    expect(declared.firstChunkMs).toBe(600_000);
    expect(undeclared.firstChunkDeclared).toBe(false);
    expect(undeclared.firstChunkMs).toBe(STREAM_FIRST_CHUNK_TIMEOUT_MS);
    // Independence, unchanged: declaring one bound says nothing about the other.
    expect(declared.idleMs).toBe(STREAM_IDLE_TIMEOUT_MS);
  });

  it('an incoherent stored value is not a declaration', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, '200000' as unknown as number, 31 * 60_000]) {
      const p = resolveStreamPatience({ firstChunkTimeoutMs: bad as number, streamIdleTimeoutMs: null });
      expect(p.firstChunkDeclared).toBe(false);
      expect(p.firstChunkMs).toBe(STREAM_FIRST_CHUNK_TIMEOUT_MS);
    }
  });

  it('THE DEFECT: a declared first-chunk timeout throws its OWN phrase, which the loop does not retry', async () => {
    const w = makeStreamWatchdog(undefined, IDLE, IDLE * 8);
    await sleep(IDLE * 3);
    expect(w.firstChunkTimedOut()).toBe(true);

    const phrase = streamTimeoutPhrase(w, declared);
    expect(phrase).toBe(STREAM_FIRST_CHUNK_TIMEOUT_ERROR);
    // The loop's grant matches on the idle phrase; this must not contain it, or the cold
    // restart comes right back.
    expect(phrase).not.toContain(STREAM_IDLE_TIMEOUT_ERROR);
    w.finish();
  });

  it('CONTROL — a provider that declared NOTHING keeps today\'s retry exactly', async () => {
    const w = makeStreamWatchdog(undefined, IDLE, IDLE * 8);
    await sleep(IDLE * 3);
    expect(w.firstChunkTimedOut()).toBe(true);
    // Cloud providers are the control: same abort, same phrase as before, same one retry.
    expect(streamTimeoutPhrase(w, undeclared)).toBe(STREAM_IDLE_TIMEOUT_ERROR);
    w.finish();
  });

  it('CONTROL — a mid-answer stall keeps the retryable phrase even with patience declared', async () => {
    const w = makeStreamWatchdog(undefined, IDLE * 8, IDLE);
    w.contentStarted();
    await sleep(IDLE * 3);
    expect(w.timedOut()).toBe(true);
    expect(w.firstChunkTimedOut()).toBe(false);
    // T65b's grant is about a stream that started and stopped. Untouched.
    expect(streamTimeoutPhrase(w, declared)).toBe(STREAM_IDLE_TIMEOUT_ERROR);
    w.finish();
  });
});
