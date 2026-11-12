// Process-wide poll fence: stopVideoJobPoller() (before `closeDb()` at shutdown) stands loops down; a boot rearms it.
// A loop's exit must read pollerStopped(): `cutBy()` covers its slot's own controller only, not `pollerSignal()`.

import { createLogger } from '../logger.js';

const logger = createLogger('video-poller-lifetime');

let lifetime = new AbortController();

export function pollerSignal(): AbortSignal {
  return lifetime.signal;
}

export function pollerStopped(): boolean {
  return lifetime.signal.aborted;
}

export function stopVideoJobPoller(): void {
  lifetime.abort();
}

export function rearmVideoJobPoller(): void {
  if (lifetime.signal.aborted) lifetime = new AbortController();
}

/** Log path for a detached loop: without it a throw would become an `unhandledRejection`. */
export function detachPollLoop(jobId: string, work: Promise<void>): void {
  void work.catch((err) => {
    logger.error('video poll loop rejected outside its own handler', {
      jobId, error: err instanceof Error ? err.message : String(err),
    });
  });
}
