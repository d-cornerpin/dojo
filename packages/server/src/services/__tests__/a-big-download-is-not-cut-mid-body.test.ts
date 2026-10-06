// ════════════════════════════════════════════════════════════════════════════════════
// t114 (CENSUS U9 + U10 + U20) — A BIG DOWNLOAD IS NOT CUT MID-BODY.
//
// THE DEFECT ALL THREE SHARE. `AbortSignal.timeout(N)` handed to `fetch` covers the WHOLE
// operation — connect, headers AND the body consumption that follows. One number therefore had to
// be both "how long may a server take to answer" and "how long may N megabytes take to arrive",
// and whatever it was set to it was wrong for one of them:
//
//   U9  a generated-and-BILLED video clip, flat 120s, aborted while bytes arrive. `markFailed`
//       makes the row terminal, so the owner paid for a clip that was then dropped.
//   U10 cloud STT fetching an audio file at 30s, in a file that permits `FETCH_MAX_BYTES = 1 GiB`.
//       The cap and the clock disagreed by orders of magnitude and the clock won — silently, on
//       exactly the long recordings a user most wants transcribed.
//   U20 a release manifest at 20s whose catch returns `''`, which the verifier reads as
//       `'refused'`. Twenty seconds of ordinary latency REJECTED a good release, on the path whose
//       whole job is to protect an update.
//
// THE SHAPE OF THE ANSWER is the one `agent/stream-patience.ts` already argues for the model
// transports: two phases, two bounds. One controller is armed for the HEADERS phase; the moment
// headers arrive the caller re-arms it from the size the server just DECLARED. The clock stops
// being a guess about the whole trip and becomes two measured questions.
//
//   §1 the resolver: a big declared body earns proportionate time, a small one does not change
//   §2 the phases are distinguishable, which is what lets a caller report the truth
//   §3 the bound is still a bound — the ceiling holds and a dead server is still cut
//   §4 the three call sites are wired to it, and U20's security posture is UNCHANGED
// ════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { phasedTransferDeadline, TRANSFER_MS_PER_MB } from '../transfer-deadline.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MB = 1024 * 1024;

function stripped(rel: string): string {
  const raw = fs.readFileSync(path.join(SRC, rel), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

/** How long the deadline actually grants a body of this declared size. */
function grantFor(bytes: number | null, opts?: { bodyBaseMs?: number; bodyCeilingMs?: number }): number {
  const d = phasedTransferDeadline({
    headersMs: 30_000,
    bodyBaseMs: opts?.bodyBaseMs ?? 60_000,
    bodyCeilingMs: opts?.bodyCeilingMs ?? 30 * 60_000,
  });
  d.armBody(bytes);
  const granted = d.grantedBodyMs()!;
  d.done();
  return granted;
}

describe('§1 the body earns time from the size the server declares', () => {
  it('THE RED: a 200 MB download gets minutes, not the flat window that killed it', async () => {
    // The U10 hurt scenario in arithmetic: a 200 MB podcast under a flat 30s had to move at
    // ~6.7 MB/s to survive. It now earns the ceiling instead.
    expect(grantFor(200 * MB)).toBe(30 * 60_000);
  });

  it('a 10 MB clip earns proportionate room rather than a one-size window', async () => {
    expect(grantFor(10 * MB)).toBe(60_000 + 10 * TRANSFER_MS_PER_MB);
  });

  it('the grant is monotonic in the declared size — more bytes is never less time', () => {
    let previous = 0;
    for (const mb of [0.1, 1, 4, 16, 64]) {
      const granted = grantFor(Math.round(mb * MB));
      expect(granted, `${mb}MB must not get less than a smaller body`).toBeGreaterThanOrEqual(previous);
      previous = granted;
    }
  });

  it('a server that will not declare a size still gets the base allowance plus one MB', () => {
    // "The server would not say" is not "the body is empty"; a missing content-length must not
    // collapse the grant to nothing, which would reinstate the defect for chunked responses.
    expect(grantFor(null)).toBe(60_000 + TRANSFER_MS_PER_MB);
    expect(grantFor(0)).toBe(60_000 + TRANSFER_MS_PER_MB);
  });
});

describe('§2 the two phases are told apart', () => {
  it('a deadline that fires before headers reports the HEADERS phase', async () => {
    const d = phasedTransferDeadline({ headersMs: 20, bodyBaseMs: 10_000, bodyCeilingMs: 60_000 });
    await new Promise((r) => setTimeout(r, 80));

    expect(d.signal.aborted, 'a server that never answers is still cut').toBe(true);
    expect(d.firedPhase(), '"the server never answered" is its own failure').toBe('headers');
    d.done();
  });

  it('a deadline that fires after armBody reports the BODY phase', async () => {
    const d = phasedTransferDeadline({ headersMs: 10_000, bodyBaseMs: 20, bodyCeilingMs: 40 });
    d.armBody(1);
    await new Promise((r) => setTimeout(r, 120));

    expect(d.signal.aborted).toBe(true);
    expect(d.firedPhase(), '"the download stalled" is a different failure a user can act on').toBe('body');
    d.done();
  });

  it('a settled transfer never fires at all, and says so', async () => {
    const d = phasedTransferDeadline({ headersMs: 10_000, bodyBaseMs: 10_000, bodyCeilingMs: 60_000 });
    d.armBody(2 * MB);
    d.done();
    await new Promise((r) => setTimeout(r, 60));

    expect(d.signal.aborted, 'done() disarms it').toBe(false);
    expect(d.firedPhase()).toBeNull();
  });

  it('the agent\'s stop is COMPOSED IN, never replaced', async () => {
    // A-5's property: the bound must not be the only way this transfer can end.
    const external = AbortSignal.timeout(20);
    const d = phasedTransferDeadline({
      headersMs: 10_000, bodyBaseMs: 10_000, bodyCeilingMs: 60_000, external,
    });
    await new Promise((r) => setTimeout(r, 80));

    expect(d.signal.aborted, 'the stop still cuts the transfer').toBe(true);
    expect(d.firedPhase(), 'and it is NOT misreported as our own deadline').toBeNull();
    d.done();
  });
});

describe('§3 the bounds are still bounds', () => {
  it('CONTROL: the body ceiling caps the grant — a huge size buys no unlimited time', () => {
    expect(grantFor(100_000 * MB, { bodyCeilingMs: 5 * 60_000 })).toBe(5 * 60_000);
  });

  it('CONTROL: the headers bound is unchanged in kind — a dead server is still cut fast', () => {
    // The fix must not make an unresponsive host cheaper to tolerate; only the BODY got room.
    const src = stripped('services/transcription.ts');
    expect(/headersMs: FETCH_TIMEOUT_MS/.test(src), 'the old flat number keeps its honest job').toBe(true);
  });
});

describe('§4 the call sites are wired to it, and U20 keeps its posture', () => {
  it('THE RED: the video asset download no longer carries a flat 120s over the whole trip', () => {
    const src = stripped('services/video-generation.ts');

    expect(
      /AbortSignal\.any\(\[slot\.signal, AbortSignal\.timeout\(120_000\)\]\)/.test(src),
      'the flat whole-operation bound is the defect',
    ).toBe(false);
    expect(/phasedTransferDeadline\(/.test(src), 'the asset download is phased').toBe(true);
    expect(/deadline\.armBody\(/.test(src), 'and it re-arms from the declared content-length').toBe(true);
  });

  it('THE RED: the STT fetch is phased, and its byte cap still fires FIRST', () => {
    const src = stripped('services/transcription.ts');

    expect(/phasedTransferDeadline\(/.test(src)).toBe(true);
    // Load-bearing ordering: the over-cap refusal must still come before `armBody`, or a 1 GiB
    // file would be patiently downloaded instead of refused.
    const capAt = src.indexOf('Audio file is too large (');
    const armAt = src.indexOf('deadline.armBody(');
    expect(capAt, 'the cap check exists').toBeGreaterThan(-1);
    expect(capAt, 'the 1 GiB refusal still precedes any transfer grant').toBeLessThan(armAt);
  });

  it('the asset-download failure distinguishes "never answered" from "stalled"', () => {
    const raw = fs.readFileSync(path.join(SRC, 'services/video-generation.ts'), 'utf8');
    expect(raw).toMatch(/did not answer within/);
    expect(raw).toMatch(/Asset download stalled/);
    // The render already succeeded and was billed, so the message says retrying is worth it.
    expect(raw).toMatch(/render itself succeeded/);
  });

  it('U20: a transient manifest failure is RETRIED instead of becoming a refusal', () => {
    const src = stripped('update/artifact-integrity.ts');

    expect(/MANIFEST_FETCH_ATTEMPTS/.test(src), 'one blip is no longer sufficient').toBe(true);
    expect(/for \(let attempt = 1; attempt <= MANIFEST_FETCH_ATTEMPTS/.test(src)).toBe(true);
  });

  it('CONTROL: U20\'s SECURITY POSTURE IS UNCHANGED — unreadable still means refused', () => {
    const src = stripped('update/artifact-integrity.ts');

    // The whole point of this path is that a manifest which exists and cannot be confirmed
    // against is never waved through. Retrying must not have turned a refusal into a pass.
    expect(/return '';/.test(src), "the unreadable marker is still returned").toBe(true);
    // A real HTTP answer (404 and friends) must still short-circuit without retrying, because
    // retrying cannot change it.
    expect(/if \(!res\.ok\) \{/.test(src)).toBe(true);
  });

  it('CONTROL: U20 still refuses LOUDLY, and says which of the two it was', () => {
    const raw = fs.readFileSync(path.join(SRC, 'update/artifact-integrity.ts'), 'utf8');
    expect(raw, 'an operator must not be left thinking the bytes failed to match')
      .toMatch(/refusing the release on absence of proof, NOT on a byte mismatch/);
  });
});
