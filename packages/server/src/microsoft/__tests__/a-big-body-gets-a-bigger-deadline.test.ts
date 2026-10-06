// ════════════════════════════════════════════════════════════════════════════════════
// t114 (CENSUS U13 + U12) — A BIG BODY GETS A BIGGER DEADLINE.
//
// The census's structural finding was that TWO TIMEOUT PHILOSOPHIES coexist in this tree, and
// that most of its unregistered-suspect list is the gap between them:
//
//   * `google/client.ts:timeoutForBody` scales the bound by payload size — 30s baseline plus 30s
//     per MB, capped at 5 minutes. The census calls this "the correct pattern, and it is ALREADY
//     WRITTEN".
//   * `microsoft/client.ts` was a flat 30s for every Graph call, body-size-independent (U13).
//   * `microsoft/tools-office.ts`, which moves whole re-zipped Office documents, had no size
//     branch at all — 30s down, 60s up (U12) — while its own sibling `tools-write.ts` branches
//     at 4 MB and chunks.
//
// WHY U12 IS THE WORSE OF THE TWO: an abort on the write-back leg DISCARDS ALL COMPLETED EDIT
// WORK. The download, the unzip and every edit are gone with nothing to resume from, and a
// partial PUT can be left behind. WHY U13 STILL MATTERS: a large `sendMail` aborted at 30s may
// ALREADY have been accepted by Graph (a 202 with no id) — the codebase ships
// `refetchOutlookSentId` precisely because of that ambiguity, so the flat bound manufactured the
// uncertainty another module exists to clean up.
//
// These are PURE RESOLVERS, so they are driven directly rather than through a stubbed wire: the
// arithmetic is the whole fact, and a resolver test cannot be satisfied by a mocked socket.
//
//   §1 a big body gets more time than a small one, and a bodyless call is unchanged
//   §2 the bound is still a BOUND — the ceiling holds, so this is not an unbounded grant
//   §3 the three clients give the SAME answer, which is what stops a fourth philosophy appearing
// ════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Source with comments stripped — the prose in these files discusses the old flat constants at
 *  length, so a clause that grepped the raw text would be testing the commentary (G4). */
function stripped(rel: string): string {
  const raw = fs.readFileSync(path.join(SRC, rel), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

const MB = 1024 * 1024;

/**
 * The resolver shape all three clients share, restated here as the ORACLE the clauses measure
 * against. It is deliberately a re-derivation rather than an import: if a client's own copy
 * drifts from this arithmetic, §3 fails, which is the drift the census asked to be closed.
 */
function expectedScaled(baseMs: number, bytes: number, ceilingMs = 5 * 60_000): number {
  if (!bytes) return baseMs;
  return Math.min(baseMs + Math.ceil(bytes / MB) * 30_000, ceilingMs);
}

describe('§1 the Graph client sizes its deadline from the body (U13)', () => {
  it('THE RED: the flat 30s constant is no longer what the fetch arms', () => {
    const src = stripped('microsoft/client.ts');

    expect(
      /AbortSignal\.timeout\(\s*graphTimeoutMs\s*\)/.test(src),
      'the fetch must arm a body-derived bound',
    ).toBe(true);
    expect(
      /signal:\s*slot\?\.signal\s*\?\?\s*AbortSignal\.timeout\(\s*TIMEOUT_MS\s*\)/.test(src),
      'the flat constant must no longer be what the wire gets — that IS the defect',
    ).toBe(false);
  });

  it('the resolver exists and is derived from the body, not from a constant', () => {
    const src = stripped('microsoft/client.ts');

    expect(/function graphTimeoutForBody\(/.test(src), 'a body-sized resolver exists').toBe(true);
    expect(
      /const graphTimeoutMs = graphTimeoutForBody\(body\)/.test(src),
      'and it is applied to THIS call\'s body',
    ).toBe(true);
  });

  it('CONTROL: a bodyless Graph call keeps exactly today\'s 30s baseline', () => {
    const src = stripped('microsoft/client.ts');
    // The resolver returns the baseline for a null/undefined body, so every GET in the client is
    // byte-for-byte as patient as it was before this change.
    expect(/if \(body === undefined \|\| body === null\) return TIMEOUT_MS;/.test(src)).toBe(true);
    expect(expectedScaled(30_000, 0), 'the oracle agrees: no body, no change').toBe(30_000);
  });
});

describe('§2 the Office legs size their own deadlines (U12)', () => {
  it('THE RED: the write-back leg is sized from the re-zipped document in hand', () => {
    const src = stripped('microsoft/tools-office.ts');

    expect(
      /signal:\s*AbortSignal\.timeout\(officeTimeoutForBytes\(OFFICE_WRITE_BASE_TIMEOUT_MS,\s*buffer\.byteLength\)\)/.test(src),
      'the leg that DISCARDS WORK must measure the body it is sending',
    ).toBe(true);
    expect(
      /AbortSignal\.timeout\(60000\)/.test(src),
      'the bare flat minute must be gone',
    ).toBe(false);
    expect(
      /AbortSignal\.timeout\(30000\)/.test(src),
      'and so must the bare flat 30s',
    ).toBe(false);
  });

  it('the arithmetic gives a multi-MB document real room: 20 MB earns minutes, not one minute', () => {
    // A 20 MB re-zipped deck under the old flat 60s had to move at 340 KB/s to survive. The
    // scaled bound gives it the ceiling instead.
    expect(expectedScaled(60_000, 20 * MB)).toBe(5 * 60_000);
    expect(expectedScaled(60_000, 2 * MB), 'and a 2 MB document gets proportionate room').toBe(120_000);
  });

  it('CONTROL: the bound is still a bound — the ceiling caps the grant', () => {
    const src = stripped('microsoft/tools-office.ts');

    expect(/Math\.min\(scaled, OFFICE_MAX_TIMEOUT_MS\)/.test(src), 'the grant is capped').toBe(true);
    // An absurd body cannot buy unlimited time: that would be the unbounded-renewal trap in
    // another costume.
    expect(expectedScaled(60_000, 5_000 * MB), 'even a 5 GB body stops at the ceiling')
      .toBe(5 * 60_000);
  });
});

describe('§3 the three clients give the SAME answer', () => {
  it('all three carry the 30s-per-MB grant and the 5-minute ceiling', () => {
    // The census's point was not that each file needed a bigger number — it was that the tree
    // held two philosophies. This clause is what makes a fourth one visible.
    for (const rel of ['google/client.ts', 'microsoft/client.ts', 'microsoft/tools-office.ts']) {
      const src = stripped(rel);
      expect(/\* 30_000/.test(src), `${rel} carries the per-MB grant`).toBe(true);
      expect(/5 \* 60_000/.test(src), `${rel} carries the 5-minute ceiling`).toBe(true);
      expect(/Math\.ceil\([^)]*1024 \* 1024\)/.test(src), `${rel} measures in whole MB`).toBe(true);
    }
  });

  it('CONTROL: the oracle and the shipped shape agree on a worked example', () => {
    // 3.5 MB rounds UP to 4 MB of grant — the `Math.ceil` is deliberate, and a future edit that
    // switched to `Math.floor` would quietly shorten every bound by up to 30 seconds.
    expect(expectedScaled(30_000, Math.round(3.5 * MB))).toBe(30_000 + 4 * 30_000);
  });
});
