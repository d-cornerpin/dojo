import { describe, it, expect } from 'vitest';
import { makeStreamWatchdog, STREAM_IDLE_TIMEOUT_ERROR } from '../model.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Millisecond-scale bounds so the whole file runs in under a second while
// exercising exactly the production logic (the bounds are injectable params;
// production uses 90s first-chunk / 60s idle).
const FIRST = 60;
const IDLE = 40;

describe('stream idle watchdog', () => {
  it('fires when no first chunk ever arrives (the 602s hang shape)', async () => {
    const w = makeStreamWatchdog(undefined, FIRST, IDLE);
    await sleep(FIRST + 30);
    expect(w.timedOut()).toBe(true);
    expect(w.signal.aborted).toBe(true);
    w.finish();
  });

  it('never fires while chunks keep arriving, even far past the first-chunk bound', async () => {
    const w = makeStreamWatchdog(undefined, FIRST, IDLE);
    for (let i = 0; i < 8; i++) {
      await sleep(IDLE / 2);
      w.bump();
    }
    expect(w.timedOut()).toBe(false);
    expect(w.signal.aborted).toBe(false);
    w.finish();
    await sleep(IDLE + 30);
    expect(w.timedOut()).toBe(false); // finish() disarms; no late fire
  });

  it('fires on a mid-stream stall after healthy chunks', async () => {
    const w = makeStreamWatchdog(undefined, FIRST, IDLE);
    w.bump();
    w.bump();
    await sleep(IDLE + 30);
    expect(w.timedOut()).toBe(true);
    expect(w.signal.aborted).toBe(true);
    w.finish();
  });

  it("the user's stop button aborts the combined signal WITHOUT marking a timeout", async () => {
    const external = new AbortController();
    const w = makeStreamWatchdog(external.signal, FIRST, IDLE);
    external.abort();
    expect(w.signal.aborted).toBe(true);
    expect(w.timedOut()).toBe(false); // stop is distinguishable from timeout
    w.finish();
  });

  it('exports the exact phrase the loop retry matches on', () => {
    expect(STREAM_IDLE_TIMEOUT_ERROR).toBe('model stream idle timeout');
  });
});
