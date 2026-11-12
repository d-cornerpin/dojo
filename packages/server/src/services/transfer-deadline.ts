// Phased transfer deadlines: one AbortController is armed for the response headers, then re-armed from the
// declared content-length once they arrive, so a slow server and a large body each get their own bound.

/**
 * 30s per declared megabyte, the same grant as google/client.ts, microsoft/client.ts and
 * microsoft/tools-office.ts; keep all four identical.
 */
export const TRANSFER_MS_PER_MB = 30_000;

export interface PhasedTransferOptions {
  headersMs: number;
  bodyBaseMs: number;
  /** Hard ceiling on the body phase, so a huge declared size cannot buy unlimited time. */
  bodyCeilingMs: number;
  /** Composed in, never replaced: the agent's stop must still cut the transfer. */
  external?: AbortSignal;
}

// Named type: the work-event-kinds conformance test reads inline 'headers' unions as written event kinds.
export type TransferPhase = 'headers' | 'body';

export interface PhasedTransfer {
  signal: AbortSignal;
  armBody(contentLengthBytes: number | null): void;
  done(): void;
  firedPhase(): TransferPhase | null;
  grantedBodyMs(): number | null;
}

export function phasedTransferDeadline(opts: PhasedTransferOptions): PhasedTransfer {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let phase: TransferPhase = 'headers';
  let fired: TransferPhase | null = null;
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
