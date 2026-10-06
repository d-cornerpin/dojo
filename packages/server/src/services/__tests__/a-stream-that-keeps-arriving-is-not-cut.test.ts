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

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { idleStreamDeadline } from '../idle-stream-deadline.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function stripped(rel: string): string {
  const raw = fs.readFileSync(path.join(SRC, rel), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('§1 the idle-stream bound: a stream that keeps arriving survives', () => {
  it('THE RED: chunks every 40ms under a 120ms idle bound survive well past the total', async () => {
    const d = idleStreamDeadline({ firstByteMs: 200, idleMs: 120, ceilingMs: 10_000 });

    // ~400ms of streaming — several times the idle bound. A flat bound of 120ms kills this.
    for (let i = 0; i < 10; i += 1) {
      await sleep(40);
      d.bump();
    }

    expect(d.signal.aborted, 'a stream that keeps delivering is never cut').toBe(false);
    expect(d.fired()).toBe(false);
    d.done();
  });

  it('THE OTHER DIRECTION: a stream that goes quiet past the bound IS cut', async () => {
    const d = idleStreamDeadline({ firstByteMs: 500, idleMs: 60, ceilingMs: 10_000 });
    d.bump();
    await sleep(200);

    expect(d.signal.aborted, 'silence is still a kill').toBe(true);
    expect(d.fired(), 'and it is OUR bound that fired, which is what makes the message honest').toBe(true);
    d.done();
  });

  it('a server that never sends a first byte is cut on the first-byte bound', async () => {
    const d = idleStreamDeadline({ firstByteMs: 60, idleMs: 10_000, ceilingMs: 10_000 });
    await sleep(200);

    expect(d.signal.aborted).toBe(true);
    d.done();
  });

  it('CONTROL: the ceiling does NOT re-arm, so bumping for ever does not buy for ever', async () => {
    // The unbounded-renewal trap, in the one place it would actually bite: a provider dribbling
    // a byte at a time would otherwise hold a slot open indefinitely.
    const d = idleStreamDeadline({ firstByteMs: 10_000, idleMs: 10_000, ceilingMs: 150 });
    for (let i = 0; i < 6; i += 1) {
      await sleep(40);
      d.bump();
    }

    expect(d.signal.aborted, 'the ceiling is immune to bumping').toBe(true);
    expect(d.fired()).toBe(true);
    d.done();
  });

  it('CONTROL: an external stop still cuts, and is NOT misreported as our deadline', async () => {
    const d = idleStreamDeadline({
      firstByteMs: 10_000, idleMs: 10_000, ceilingMs: 10_000, external: AbortSignal.timeout(40),
    });
    await sleep(140);

    expect(d.signal.aborted, 'the agent\'s stop still reaches the stream').toBe(true);
    expect(d.fired(), 'a stop is not a timeout and must never wear its name').toBe(false);
    d.done();
  });

  it('CONTROL: done() disarms both timers', async () => {
    const d = idleStreamDeadline({ firstByteMs: 50, idleMs: 50, ceilingMs: 60 });
    d.done();
    await sleep(180);

    expect(d.signal.aborted, 'a settled stream has no live clock').toBe(false);
  });
});

describe('§2 U11 — the TTS narration is bounded by its gaps, not its length', () => {
  it('THE RED: the flat 180s whole-dial bound is gone', () => {
    const src = stripped('services/audio-generation.ts');

    expect(
      /AbortSignal\.any\(\[slot\.signal, AbortSignal\.timeout\(180_000\)\]\)/.test(src),
      'a flat bound over a streamed body is the defect',
    ).toBe(false);
    expect(/idleStreamDeadline\(/.test(src), 'the dial is idle-bounded').toBe(true);
  });

  it('every audio chunk re-arms it — the collector finally reports what it reads', () => {
    const src = stripped('services/audio-generation.ts');

    expect(/onChunk\?\.\(\)/.test(src), 'the collector emits a per-chunk signal').toBe(true);
    expect(/\(\) => ttsDeadline\.bump\(\)/.test(src), 'and the dial re-arms on it').toBe(true);
  });

  it('a stalled narration says it STALLED, not that the provider errored', () => {
    const raw = fs.readFileSync(path.join(SRC, 'services/audio-generation.ts'), 'utf8');
    expect(raw).toMatch(/Audio stream stalled/);
    expect(raw, 'and names what was measured').toMatch(/no audio arrived for/);
  });
});

describe('§3 U17 — web_fetch bounds the answer and the download separately', () => {
  it('THE RED: the 15s no longer covers body consumption', () => {
    const src = stripped('agent/web-tools.ts');

    expect(
      /openAgentCall\(agentId, 'turn', AbortSignal\.timeout\(15000\)\);\s*\n\s*if \(slot\.refused\) \{ slot\.release\(\); return STOPPED_BY_USER; \}/.test(src),
      'the whole-trip bound on the fetch path is the defect',
    ).toBe(false);
    expect(/phasedTransferDeadline\(/.test(src), 'the fetch path is phased').toBe(true);
    expect(/deadline\.armBody\(/.test(src), 'and the body is re-armed from content-length').toBe(true);
  });

  it('CONTROL: the server still only gets 15s to ANSWER — nothing was loosened for a dead host', () => {
    const src = stripped('agent/web-tools.ts');
    expect(/headersMs: WEB_FETCH_HEADERS_TIMEOUT_MS/.test(src)).toBe(true);
    expect(/const WEB_FETCH_HEADERS_TIMEOUT_MS = 15_000;/.test(src), 'the old number keeps its honest job').toBe(true);
  });

  it('CONTROL: the deadline is disarmed where the slot is released, so no timer outlives the fetch', () => {
    const src = stripped('agent/web-tools.ts');
    expect(/deadline\.done\(\);\s*\n\s*slot\.release\(\);/.test(src)).toBe(true);
  });
});

describe('§4 U15 + U18 — a child that is still talking keeps its window', () => {
  it('THE RED (U15): neither tunnel path arms a flat deadline from spawn any more', () => {
    const src = stripped('services/tunnel.ts');

    expect(/Tunnel failed to start within 30 seconds/.test(src), 'the flat quick-tunnel wall is gone').toBe(false);
    expect(/Tunnel failed to connect within 60 seconds/.test(src), 'and so is the named-tunnel wall').toBe(false);
    // BOTH paths, not just the first — fixing one of a matched pair is how this family survives.
    // Counted by CALL SITE (the label argument), so the function's own definition is not scored
    // as a third caller.
    const armed = src.match(/armTunnelStartDeadline\('/g) ?? [];
    expect(armed.length, 'both start paths are covered').toBe(2);
  });

  it('U15: the child\'s own output is what re-arms it', () => {
    const src = stripped('services/tunnel.ts');
    // The handler was already reading this output; only the clock was not.
    const notes = src.match(/noteTunnelOutput\(\);/g) ?? [];
    expect(notes.length, 'both stream handlers bump the deadline').toBeGreaterThanOrEqual(2);
    expect(/startWatch\.lastOutputAt/.test(src)).toBe(true);
  });

  it('U15: a silent child and an over-ceiling child get DIFFERENT reasons', () => {
    const raw = fs.readFileSync(path.join(SRC, 'services/tunnel.ts'), 'utf8');
    expect(raw).toMatch(/went silent for/);
    expect(raw).toMatch(/did not produce a URL within/);
  });

  it('THE RED (U18): the whisper boot wall reads progress instead of only the clock', () => {
    const src = stripped('voice/stt-service.ts');

    expect(/noteWhisperBootOutput\(\);/.test(src), 'the output handlers report progress').toBe(true);
    expect(/lastWhisperBootOutputAt/.test(src), 'and the wait consults it').toBe(true);
    expect(
      /whisper-server did not become ready on port \$\{port\} within \$\{timeoutMs\}ms/.test(src),
      'the old message claimed a readiness fact it never measured',
    ).toBe(false);
  });

  it('U18: the honest message says it stopped REPORTING, which is what was observed', () => {
    const raw = fs.readFileSync(path.join(SRC, 'voice/stt-service.ts'), 'utf8');
    expect(raw).toMatch(/stopped reporting progress for/);
    expect(raw, 'and the ceiling is named separately').toMatch(/within its .* ceiling/);
  });

  it('CONTROL (U18): the 10s TCP probe is untouched — a bound that matches its work is not a defect', () => {
    const src = stripped('voice/stt-service.ts');
    expect(/function probeTcp\(port: number, timeoutMs = 1000\)/.test(src)).toBe(true);
  });
});

describe('§5 U21 — the one with no liveness fact, fixed as an argued raise and labelled as such', () => {
  it('the AppleScript ceiling is named, not a bare literal', () => {
    const src = stripped('agent/system-control.ts');

    expect(/timeout: APPLESCRIPT_CEILING_MS/.test(src)).toBe(true);
    expect(/timeout: 30000/.test(src), 'the bare 30s that killed Finder batches is gone').toBe(false);
  });

  it('the sips CONVERSION is raised while the dimension PROBE is deliberately not', () => {
    const src = stripped('agent/image-prep.ts');

    expect(/timeout: SIPS_CONVERT_CEILING_MS/.test(src), 'the conversion earns a real ceiling').toBe(true);
    // Reading two dimension fields really is instant. Raising it would be cargo-culting the fix.
    expect(/timeout: 10_000/.test(src), 'the probe keeps its matched bound').toBe(true);
  });

  it('the reason it is NOT an idle bound is written down, because that is the interesting part', () => {
    const raw = fs.readFileSync(path.join(SRC, 'agent/system-control.ts'), 'utf8');
    // A reviewer asking "why didn't this one get the re-arm treatment?" must find the answer at
    // the site rather than having to re-derive that osascript emits nothing until it finishes.
    expect(raw).toMatch(/NO LIVENESS FACT HERE/);
    expect(raw).toMatch(/produces NO\s*\n?\s*\/\/ incremental output|produces NO/);
  });

  it('CONTROL: a bound still exists at both sites — this is a raise, not a removal', () => {
    const sc = stripped('agent/system-control.ts');
    const ip = stripped('agent/image-prep.ts');
    expect(/const APPLESCRIPT_CEILING_MS = 5 \* 60_000;/.test(sc)).toBe(true);
    expect(/const SIPS_CONVERT_CEILING_MS = 2 \* 60_000;/.test(ip)).toBe(true);
  });
});
