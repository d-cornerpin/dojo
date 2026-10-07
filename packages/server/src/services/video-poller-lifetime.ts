// ════════════════════════════════════════
// services/video-poller-lifetime.ts — t126. ONE PROCESS'S WILLINGNESS TO KEEP POLLING.
//
// `video-job-poller.ts` fires `pollLoop` detached: it runs for up to thirty minutes, is asleep
// in its backoff for nearly all of them, and used to be tied to nothing at all. So a loop that
// woke after `index.ts`'s shutdown — `closeDb()`, then exit — reached `getDb()` on a closed
// handle, and THE THROW DID NOT BECOME A LOG LINE: it landed in the loop's own `catch`, whose
// `markFailed` calls `getDb()` AGAIN and threw the same error back OUT of the handler. The
// honest log path was skipped and the detached promise rejected with nobody listening — one
// `unhandledRejection` per surviving loop, which is the intermittent `Errors 1 error` that
// exited a full suite 1 while reporting every test passed.
//
// It lives in its own module for the reason `media-job-status.ts` does: the question "is this
// process still polling?" is asked by the loop, by `index.ts`'s shutdown and by the clauses, and
// a second copy of the answer is how a vocabulary drifts. The loop reads `pollerStopped()` at
// each of the two points it could next touch the DB; the stand-down WRITES NOTHING, because a
// shutdown is not a verdict on a render still running at the provider — the row is left active
// and `startVideoJobPoller`'s boot resume adopts it, which is what that resume is for.
//
// WHY THE LOOP READS THIS RATHER THAN ASKING ITS SLOT. `pollerSignal()` IS composed into the
// loop's `AgentCallSlot`, and that is what cuts the in-flight HTTP leg and wakes the backoff
// sleep. But `AgentCallSlot.cutBy()` answers for the slot's OWN controller only — by design, so
// a caller's clock can never be misread as a stop — so a loop that trusted `cutBy()` alone would
// see an aborted signal, an instantly-resolving sleep, and no reason to exit: the hot-spin trap
// `video-job-poller.ts`'s A-5 note already documents, one narrowing away. Hence two separate
// questions, deliberately: the slot's, and this module's.
// ════════════════════════════════════════

import { createLogger } from '../logger.js';

const logger = createLogger('video-poller-lifetime');

let lifetime = new AbortController();

/** Hand this to `openAgentCall` as an external: it cuts the legs and wakes the backoff sleep. */
export function pollerSignal(): AbortSignal {
  return lifetime.signal;
}

/** The question the loop asks at each point it could next touch the DB. */
export function pollerStopped(): boolean {
  return lifetime.signal.aborted;
}

/** Stop every poll loop at its next wake. `index.ts`'s shutdown calls this BEFORE `closeDb()`,
 *  which is the whole point of it. Idempotent. */
export function stopVideoJobPoller(): void {
  lifetime.abort();
}

/** A new process generation. The fence is permanent by design — a stopped poller must not
 *  resume on the next `enqueueVideoJob` — so a boot is the only thing that lifts it. */
export function rearmVideoJobPoller(): void {
  if (lifetime.signal.aborted) lifetime = new AbortController();
}

/** The honest log path for a detached loop: with no rejection handler any throw — including one
 *  from the error path itself — becomes an `unhandledRejection` that kills the exit code and
 *  says nothing useful. The worst case through here is a log line. */
export function detachPollLoop(jobId: string, work: Promise<void>): void {
  void work.catch((err) => {
    logger.error('video poll loop rejected outside its own handler', {
      jobId, error: err instanceof Error ? err.message : String(err),
    });
  });
}
