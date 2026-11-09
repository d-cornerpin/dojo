// ════════════════════════════════════════════════════════════════════════════════════
// t114 (CENSUS U11 + U15 + U17 + U18 + U21) — WHAT KEEPS ARRIVING IS NOT CUT.
//
// Five clocks, one question asked five ways: is there a measured fact of liveness here, and does
// the clock consult it? Four times the answer was yes-and-no — the fact existed, was already
// being read for some other purpose, and the clock ignored it. Once the answer was genuinely no,
// and that case is fixed differently and says so.
//
//   U11 TTS: a flat 180s covering the streamed body. A long narration delivering `pcm16` at
//       t=180s was cut and ALL COLLECTED AUDIO DISCARDED — the collector throws and every second
//       of speech already assembled goes with it. The body is a stream; arrival is the proof.
//   U17 `web_fetch` 15s, where undici's signal covers BODY CONSUMPTION: a 5 MB page at 400 KB/s
//       needs ~12.5s of body alone, so a healthily streaming download died with the page nearly
//       in hand.
//   U15 cloudflared: a flat 30s/60s from spawn, then SIGTERM+SIGKILL of a child possibly
//       mid-handshake. "No URL yet" is absence of evidence — and cloudflared logs its progress
//       continuously to a handler that was ALREADY reading it.
//   U18 whisper-server: a flat 60s wall that polled a TCP PORT and never measured boot PROGRESS,
//       abandoning a cold first load of a large model off a slow disk. Its output was being read
//       straight into the debug log.
//   U21 AppleScript / `sips`: SIGTERM mid-action with side effects already applied. THE ONE WITH
//       NO LIVENESS FACT — `osascript` and `sips` print nothing until they finish — so this is an
//       argued bound RAISE, not a liveness fix, and §5 pins that distinction rather than
//       pretending a re-arm happened.
//
// §1 drives the shared idle-stream mechanism with real timers; §2–§5 read the wiring with
// comments stripped (G4), because standing up cloudflared or a whisper model in a unit test
// would be testing the operator's machine.
// ════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { idleStreamDeadline } from '../idle-stream-deadline.js';

// ── t128 — §1 RUNS ON A FAKE CLOCK ──
//
// These six clauses drove `idleStreamDeadline` with real `sleep`s against real bounds: 40ms gaps
// under a 120ms bound, 200ms of silence against 60ms, and so on. My own t121 sweep flagged this
// file — "same family… margins are 3x rather than 1.3x, so it has not been seen to red, but it is
// the same bet" — and by now three other members of that family have cost a gate-red each, one of
// them in a file I wrote with exactly that note attached.
//
// `idleStreamDeadline` is built on `setTimeout`, so a fake clock makes every one of these exact in
// BOTH directions: the survival clauses advance less than the bound, the kill clauses advance past
// it, and nothing is racing anything. Every number below is the number that was always there — no
// bound and no margin was changed.
describe('§1 the idle-stream bound: a stream that keeps arriving survives', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('THE RED: chunks every 40ms under a 120ms idle bound survive well past the total', async () => {
    const d = idleStreamDeadline({ firstByteMs: 200, idleMs: 120, ceilingMs: 10_000 });

    // ~400ms of streaming — several times the idle bound. A flat bound of 120ms kills this.
    for (let i = 0; i < 10; i += 1) {
      await vi.advanceTimersByTimeAsync(40);
      d.bump();
    }

    expect(d.signal.aborted, 'a stream that keeps delivering is never cut').toBe(false);
    expect(d.fired()).toBe(false);
    d.done();
  });

  it('THE OTHER DIRECTION: a stream that goes quiet past the bound IS cut', async () => {
    const d = idleStreamDeadline({ firstByteMs: 500, idleMs: 60, ceilingMs: 10_000 });
    d.bump();
    await vi.advanceTimersByTimeAsync(200);

    expect(d.signal.aborted, 'silence is still a kill').toBe(true);
    expect(d.fired(), 'and it is OUR bound that fired, which is what makes the message honest').toBe(true);
    d.done();
  });

  it('a server that never sends a first byte is cut on the first-byte bound', async () => {
    const d = idleStreamDeadline({ firstByteMs: 60, idleMs: 10_000, ceilingMs: 10_000 });
    await vi.advanceTimersByTimeAsync(200);

    expect(d.signal.aborted).toBe(true);
    d.done();
  });

  it('CONTROL: the ceiling does NOT re-arm, so bumping for ever does not buy for ever', async () => {
    // The unbounded-renewal trap, in the one place it would actually bite: a provider dribbling
    // a byte at a time would otherwise hold a slot open indefinitely.
    const d = idleStreamDeadline({ firstByteMs: 10_000, idleMs: 10_000, ceilingMs: 150 });
    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(40);
      d.bump();
    }

    expect(d.signal.aborted, 'the ceiling is immune to bumping').toBe(true);
    expect(d.fired()).toBe(true);
    d.done();
  });

  it('CONTROL: an external stop still cuts, and is NOT misreported as our deadline', async () => {
    // t128: the external signal is an explicit `AbortController`, not `AbortSignal.timeout`.
    // Two reasons, and the first is a measured trap: `AbortSignal.timeout` is a PLATFORM api, not a
    // patched `setTimeout`, so a fake clock cannot advance it and the stop never arrives — this
    // clause went red on exactly that when §1 moved to fake timers. The second is that the subject
    // needs no clock at all: "a stop is not misreported as our deadline" is about WHICH signal
    // fired, so aborting it outright is both exact and closer to what a user's stop actually is.
    const external = new AbortController();
    const d = idleStreamDeadline({
      firstByteMs: 10_000, idleMs: 10_000, ceilingMs: 10_000, external: external.signal,
    });
    external.abort();
    await vi.advanceTimersByTimeAsync(140);

    expect(d.signal.aborted, 'the agent\'s stop still reaches the stream').toBe(true);
    expect(d.fired(), 'a stop is not a timeout and must never wear its name').toBe(false);
    d.done();
  });

  it('CONTROL: done() disarms both timers', async () => {
    const d = idleStreamDeadline({ firstByteMs: 50, idleMs: 50, ceilingMs: 60 });
    d.done();
    await vi.advanceTimersByTimeAsync(180);

    expect(d.signal.aborted, 'a settled stream has no live clock').toBe(false);
  });
});
