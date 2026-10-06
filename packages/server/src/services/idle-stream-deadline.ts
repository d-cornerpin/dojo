// ════════════════════════════════════════════════════════════════════════════
// IDLE DEADLINES FOR A STREAMED RESPONSE BODY (t114, census U11 / U17).
//
// The sibling of `transfer-deadline.ts`, for the case where there is no size to scale by. A
// streamed body has no `content-length` — a TTS narration or a chunked page arrives as it is
// produced — so the measured fact of liveness is not "how many bytes were promised" but "did
// another chunk arrive". That makes this the `makeStreamWatchdog` shape the model transports use,
// applied to a `fetch` body instead of a token stream: bound the GAP, re-arm on every chunk.
//
// THE DEFECT IT REPLACES, twice over:
//
//   U11 `services/audio-generation.ts` — a flat 180s covering the whole dial INCLUDING the
//       streamed body. A long narration actively delivering `pcm16` at t=180s was cut and ALL
//       COLLECTED AUDIO DISCARDED: the collector throws and every second of speech already
//       assembled goes with it. Chunk arrival was never consulted, though the body is a stream
//       and arrival is precisely the proof the provider is working.
//   U17 `agent/web-tools.ts` — `web_fetch` at 15s, where undici's signal covers BODY
//       CONSUMPTION. A 5 MB page at 400 KB/s needs ~12.5s of body alone, so a healthily
//       streaming download was aborted with the page nearly in hand.
//
// THREE BOUNDS, each named for the one job it can actually do. The old flat numbers were asked to
// be all three at once, which is why no value for them was right:
//
//   firstByteMs — the server may be slow to START. Nothing has arrived, so there is nothing to
//                 measure; this is the one genuinely time-shaped question.
//   idleMs      — once bytes are moving, the only honest question is whether they still are.
//                 Re-arms on every chunk.
//   ceilingMs   — does NOT re-arm. An idle bound alone can be held open for ever by a sender
//                 dribbling a byte a minute, which is the unbounded-renewal trap the stream
//                 watchdog's own header refuses.
//
// `fired()` lets the caller say "it went quiet" rather than emitting a generic abort, which is
// what makes the kill honest — and in U11's case tells the user their audio was stopped rather
// than that the provider errored.
// ════════════════════════════════════════════════════════════════════════════

export interface IdleStreamOptions {
  /** How long the server may take to send the FIRST byte. */
  firstByteMs: number;
  /** Tolerated gap between chunks once bytes are moving. Re-arms on each chunk. */
  idleMs: number;
  /** The one bound on total life. Does not re-arm. */
  ceilingMs: number;
  /** Composed in, never replaced: the agent's stop must still cut the stream. */
  external?: AbortSignal;
}

export interface IdleStreamDeadline {
  /** Hand this to `fetch`, and to the body read that follows it. */
  signal: AbortSignal;
  /** A chunk arrived: re-arm the idle bound. Safe to call after settling. */
  bump(): void;
  /** Settle: clears whichever timer is live. Safe to call twice. */
  done(): void;
  /** True when THIS deadline aborted the stream (never true for an external stop). */
  fired(): boolean;
}

export function idleStreamDeadline(opts: IdleStreamOptions): IdleStreamDeadline {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  let didFire = false;

  const arm = (ms: number): void => {
    if (settled) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      didFire = true;
      controller.abort();
    }, ms);
    timer.unref?.();
  };

  // The ceiling is armed once and never touched again — that is what makes it a ceiling.
  const ceilingTimer = setTimeout(() => {
    didFire = true;
    controller.abort();
  }, opts.ceilingMs);
  ceilingTimer.unref?.();

  arm(opts.firstByteMs);

  return {
    signal: opts.external
      ? AbortSignal.any([controller.signal, opts.external])
      : controller.signal,
    bump: (): void => { arm(opts.idleMs); },
    done: (): void => {
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      clearTimeout(ceilingTimer);
    },
    fired: () => didFire,
  };
}
