// Idle deadlines for a streamed response body: it has no `content-length`, so liveness is "did another chunk
// arrive", not bytes promised (sibling of `transfer-deadline.ts`; the `makeStreamWatchdog` shape applied to `fetch`).
// Three bounds: firstByteMs (a server slow to START), idleMs (re-armed on every chunk) and ceilingMs (never re-arms,
// so a sender dribbling a byte a minute cannot hold it open).

export interface IdleStreamOptions {
  firstByteMs: number;
  idleMs: number;
  ceilingMs: number;
  /** Composed in, never replaced: the agent's stop must still cut the stream. */
  external?: AbortSignal;
}

export interface IdleStreamDeadline {
  signal: AbortSignal;
  /** A chunk arrived: re-arm the idle bound. Safe to call after settling. */
  bump(): void;
  /** Settle: clear both timers. Safe to call twice. */
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
