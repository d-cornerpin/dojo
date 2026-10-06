// ════════════════════════════════════════════════════════════════════════════
// PHASED TRANSFER DEADLINES (t114, census U9 / U10 / U17 / U20).
//
// THE DEFECT THESE FOUR SHARE. `AbortSignal.timeout(N)` handed to `fetch` covers the WHOLE
// operation — the connect, the headers AND the body consumption that follows. So one number has
// to be simultaneously "how long may a server take to answer" and "how long may 200 MB take to
// arrive", and whatever it is set to, it is wrong for one of them. Set for the handshake it kills
// every large download mid-body; set for the download it lets a dead server hold a slot for
// minutes. The census found the same shape four times:
//
//   U9  a generated-and-BILLED video clip, flat 120s, aborted while bytes arrive -> terminal
//   U10 cloud STT: 30s to fetch an audio file the same file permits to be 1 GiB
//   U17 `web_fetch` 15s, where a 5 MB page at 400 KB/s needs ~12.5s of BODY alone
//   U20 a release manifest at 20s, whose timeout is read downstream as 'refused'
//
// THE SHAPE OF THE ANSWER, and it is the one `agent/stream-patience.ts` already argues for the
// model transports: the two phases get two bounds. A single `AbortController` is armed for the
// HEADERS phase; the moment headers arrive the caller calls `armBody(contentLength)` and the same
// controller is re-armed with a deadline derived from the size the server just DECLARED. The
// clock stops being a guess about the whole trip and becomes two measured questions — "did the
// server answer?" and "is this many bytes moving?".
//
// `firedPhase()` is what lets a caller report the truth rather than a generic abort: "the server
// never answered" and "the download stalled 40 MB in" are different failures and a user can act
// on the difference. U20 in particular NEEDS it, because its catch turns any failure into a
// `'refused'` verdict that rejects a perfectly good release.
// ════════════════════════════════════════════════════════════════════════════

/** 30s per declared megabyte, the grant `google/client.ts` established and the Graph and Office
 *  clients now carry. Kept identical on purpose: a fifth number for the same question is the
 *  drift the census asked to be closed. */
export const TRANSFER_MS_PER_MB = 30_000;

export interface PhasedTransferOptions {
  /** How long the server may take to produce response HEADERS. */
  headersMs: number;
  /** The body's allowance before any per-MB grant — covers a small body completely. */
  bodyBaseMs: number;
  /** Hard ceiling on the body phase, so a huge declared size cannot buy unlimited time. */
  bodyCeilingMs: number;
  /** Composed in, never replaced: the agent's stop must still cut the transfer. */
  external?: AbortSignal;
}

export interface PhasedTransfer {
  /** Hand this to `fetch` AND to any body read that follows it. */
  signal: AbortSignal;
  /**
   * Headers are in. Re-arms the deadline from the size the server declared; a missing or
   * unparseable `content-length` falls back to the base allowance plus one megabyte's grant,
   * which is the honest reading of "the server would not say".
   */
  armBody(contentLengthBytes: number | null): void;
  /** Settle: clears whichever timer is live. Safe to call twice. */
  done(): void;
  /** Which phase's bound expired, or null if this deadline never fired. */
  firedPhase(): 'headers' | 'body' | null;
  /** The body allowance that was actually granted, for an honest error message. */
  grantedBodyMs(): number | null;
}

export function phasedTransferDeadline(opts: PhasedTransferOptions): PhasedTransfer {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let phase: 'headers' | 'body' = 'headers';
  let fired: 'headers' | 'body' | null = null;
  let grantedBodyMs: number | null = null;

  const arm = (ms: number): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      fired = phase;
      controller.abort();
    }, ms);
    timer.unref?.();
  };

  arm(opts.headersMs);

  return {
    signal: opts.external
      ? AbortSignal.any([controller.signal, opts.external])
      : controller.signal,
    armBody: (contentLengthBytes: number | null): void => {
      phase = 'body';
      const declaredMb = contentLengthBytes && Number.isFinite(contentLengthBytes) && contentLengthBytes > 0
        ? Math.ceil(contentLengthBytes / (1024 * 1024))
        : 1;
      const ms = Math.min(opts.bodyBaseMs + declaredMb * TRANSFER_MS_PER_MB, opts.bodyCeilingMs);
      grantedBodyMs = ms;
      arm(ms);
    },
    done: (): void => {
      if (timer) { clearTimeout(timer); timer = null; }
    },
    firedPhase: () => fired,
    grantedBodyMs: () => grantedBodyMs,
  };
}
