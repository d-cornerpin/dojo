// db/with-lock.ts — the platform's single-process mutual-exclusion primitive.
//
// One key, one critical section at a time. Callers either WAIT their turn
// (default) or SKIP entirely when the key is already held (`ifBusy:'skip'`).
// It exists because the platform had no mutual exclusion at all: two compaction
// runs for the same agent could interleave and write competing summary sets
// (research 22 — 11.4% of depth-0 summaries, 44/387, corrupted in real data).
//
// Scope, stated so nobody mistakes it for more: this is IN-PROCESS ONLY. It is
// a promise chain in one Node process, not a database lock and not a file lock.
// A second server process holds none of these keys. That is sufficient for the
// race it was built for (one dojo server owns its box) and insufficient for
// anything cross-process — say so rather than assume it.
//
// ── AS-BUILT DEVIATION (PHASE-1 T2, 2026-07-27) ────────────────────────────
// PHASE-1.md Task T2 supplies this implementation verbatim and instructs the
// executor to transcribe it. It was transcribed exactly and it FAILED two of
// its own contract tests, so ONE line is corrected here and nothing else.
//
// The plan's line reads:
//     chains.set(key, prev.then(() => gate));
//     ... finally { release(); if (chains.get(key) === gate) chains.delete(key); }
// The map holds `prev.then(() => gate)` — a NEW promise. The finally compares
// the map against `gate` itself. Those are never the same object, so
// `chains.delete(key)` is unreachable and the key is never released from the
// map. Measured directly: `chains.get(key) === gate` -> false.
//
// Consequence, which is why this could not ship as written: `ifBusy:'skip'`
// tests `chains.has(key)`, so after the FIRST call for a key every later call
// returns undefined without running. Adopted at `checkAndCompact` with
// `{ifBusy:'skip'}` — as T2 Step 2 requires — an agent would compact exactly
// once per server process and then silently stop forever. Nothing throws,
// nothing logs; memory just quietly stops being compacted.
//
// The repair is to compare against the promise actually stored (`mine`). The
// chaining, the skip check, the gate, the await, and the try/finally are
// unchanged from the plan. Two tests in `__tests__/with-lock.test.ts` fail
// against the verbatim text and pass against this one; both are recorded RED
// in `.superpowers/sdd/PHASE-1/task-T2-report.md`.
// ───────────────────────────────────────────────────────────────────────────

const chains = new Map<string, Promise<unknown>>();

export async function withLock<T>(key: string, fn: () => Promise<T>,
  opts: { ifBusy?: 'wait' | 'skip' } = {}): Promise<T | undefined> {
  if (opts.ifBusy === 'skip' && chains.has(key)) return undefined;
  const prev = chains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  // `mine` is what the map holds, so the finally can recognise it and know
  // whether this call is still the tail of the chain (nobody queued behind it).
  const mine = prev.then(() => gate);
  chains.set(key, mine);
  await prev;
  try { return await fn(); }
  finally { release(); if (chains.get(key) === mine) chains.delete(key); }
}
