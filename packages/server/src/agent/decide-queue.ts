// ════════════════════════════════════════════════════════════════════════════
// v3.5 — decide()'s ONE QUEUE (split from `decide.ts`, t274 fix round 1, so the seam stays a small file).
// ════════════════════════════════════════════════════════════════════════════

/**
 * ONE QUEUE (t268 fix round 2): the local Ollama answers one request at a time, so decide() calls go one after
 * another — each call's clock starts when it is SENT, never while it waits (calls dialled together spent their
 * clocks queued in Ollama, and most shadow verdicts of a busy fold were lost). A slot is released however its
 * call ends, a throw included.
 *
 * WAITER FIRST (t274 fix round 1): the queue is explicit, not a promise chain. A caller that WAITS is served
 * before every background ask that has not started — its patience is never spent queueing behind shadow asks —
 * and waited callers stay FIFO among themselves while background asks stay FIFO among themselves. Work already
 * running is never pre-empted or cancelled. STALE DROP: a queued background ask whose `stale()` is true at the
 * moment its turn comes is dropped without running (`{ left: true }`); an entry whose `leave` aborts (or arrived
 * aborted) is likewise dropped at once and never delays the entries behind it.
 *
 * WHAT IS AHEAD (proof-fix N): each entry states the time its call is allowed (`allowedMs`, decide()'s measured
 * clock for its size), so a waited caller can be told how long it must wait behind the call in flight and the waited
 * callers ahead of it (`aheadOfAWaiterMs`) — the H8 run lost nearly every waited reply ask queued behind a 30 s check.
 */
type Entry<T> = {
  leave: AbortSignal | null;
  work: () => Promise<T>;
  background: boolean;
  stale?: () => boolean;
  allowedMs: () => number;
  resolve: (r: { left: true } | { left: false; value: T }) => void;
  reject: (e: unknown) => void;
  queued: boolean;
  onAbort: (() => void) | null;
};

const queue: Entry<any>[] = [];
let running = false;
/** When the call in flight runs out of its own allowed time (its clock cuts it then). */
let runningUntil = 0;

/** The most a waited caller joining NOW can spend queued: what the call in flight may still take, plus the allowed
 *  time of every waited caller ahead of it (background asks queue behind it, and a new waiter behind it). */
export function aheadOfAWaiterMs(): number {
  let ms = running ? Math.max(0, runningUntil - Date.now()) : 0;
  for (const e of queue) if (!e.background) ms += e.allowedMs();
  return ms;
}

export async function inTurn<T>(
  leave: AbortSignal | null, work: () => Promise<T>,
  opts?: { background?: boolean; stale?: () => boolean; allowedMs?: () => number },
): Promise<{ left: true } | { left: false; value: T }> {
  const background = opts?.background ?? false;
  const stale = background ? opts?.stale : undefined;
  let resolve!: (r: { left: true } | { left: false; value: T }) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<{ left: true } | { left: false; value: T }>((res, rej) => { resolve = res; reject = rej; });
  if (leave?.aborted) {
    resolve({ left: true });  // arrived aborted: never runs, never delays the queue
    return promise;
  }
  const entry: Entry<T> = { leave, work, background, stale, allowedMs: opts?.allowedMs ?? (() => 0), resolve, reject, queued: true, onAbort: null };
  if (leave) {
    entry.onAbort = (): void => {
      if (entry.queued) {
        remove(entry);
        resolve({ left: true });  // left while queued: those behind it are unaffected
      }
    };
    leave.addEventListener('abort', entry.onAbort, { once: true });
  }
  queue.push(entry);
  pump();
  return promise;
}

/** Serves the next turn: oldest queued WAITED caller if any, else the oldest queued BACKGROUND ask. */
function pump(): void {
  if (running) return;
  for (;;) {
    const entry = next();
    if (!entry) return;
    if (entry.leave?.aborted) { remove(entry); entry.resolve({ left: true }); continue; }
    if (entry.background && entry.stale && staleTrue(entry.stale)) { remove(entry); entry.resolve({ left: true }); continue; }
    start(entry);
    return;
  }
}

/** The first queued entry by priority: waited callers first (FIFO), then background asks (FIFO). */
function next(): Entry<any> | undefined {
  for (const e of queue) if (!e.background) return e;
  for (const e of queue) if (e.background) return e;
  return undefined;
}

/** `stale` is only consulted at turn time; a throw counts as not stale. */
function staleTrue(stale: () => boolean): boolean {
  try { return stale(); } catch { return false; }
}

function remove(entry: Entry<any>): void {
  const i = queue.indexOf(entry);
  if (i >= 0) queue.splice(i, 1);
  entry.queued = false;
  if (entry.onAbort) { entry.leave?.removeEventListener('abort', entry.onAbort); entry.onAbort = null; }
}

function start(entry: Entry<any>): void {
  remove(entry);  // no longer queued: it is the running turn
  running = true;
  runningUntil = Date.now() + entry.allowedMs();
  void (async () => {
    try {
      entry.resolve({ left: false, value: await entry.work() });
    } catch (e) {
      entry.reject(e);
    } finally {
      running = false;
      pump();
    }
  })();
}
