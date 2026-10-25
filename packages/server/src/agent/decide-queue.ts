// ════════════════════════════════════════════════════════════════════════════
// v3.5 — decide()'s ONE QUEUE (split from `decide.ts`, t274 fix round 1, so the seam stays a small file).
// ════════════════════════════════════════════════════════════════════════════

/**
 * ONE QUEUE (t268 fix round 2): the local Ollama answers one request at a time, so decide() calls go one after
 * another — each call's clock starts when it is SENT, never while it waits (calls dialled together spent their
 * clocks queued in Ollama, and most shadow verdicts of a busy fold were lost). A slot is released however its
 * call ends, a throw included.
 */
let tail: Promise<void> = Promise.resolve();
export async function inTurn<T>(leave: AbortSignal | null, work: () => Promise<T>): Promise<{ left: true } | { left: false; value: T }> {
  const before = tail;
  let release!: () => void;
  tail = new Promise<void>((r) => { release = r; });
  if (!leave) await before;
  else if (!(await turnComes(before, leave))) {
    // Left the queue (t274 fix round 1): those behind it still wait for the call AHEAD, never for this one.
    void before.then(release);
    return { left: true };
  }
  try {
    return { left: false, value: await work() };
  } finally {
    release();
  }
}
/** True when the calls ahead are done; false when `leave` aborts first. `before` never rejects. */
function turnComes(before: Promise<void>, leave: AbortSignal): Promise<boolean> {
  if (leave.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const onLeave = (): void => resolve(false);
    leave.addEventListener('abort', onLeave, { once: true });
    void before.then(() => { leave.removeEventListener('abort', onLeave); resolve(true); });
  });
}
