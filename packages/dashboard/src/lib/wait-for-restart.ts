// Waiting for the server after "Update Now" or a rollback.
//
// The server answers the request and restarts some time LATER, so the first answer after the
// request may come from the OLD process. The page may only reload (and the flow may only be
// called finished) when the server it reconnects to reports the version the request promised,
// or, when that version is unknown, a different version or proof that the server went away and
// came back. There is no timer that gives up: the wait ends on real signals only: the version,
// or the update episode the server reports (a rolled-back or failed update is said out loud).
// The caller keeps a plain status on screen the whole time and can cancel (unmount).

import * as api from './api';

export type RestartOutcome =
  | { state: 'ready' }
  | { state: 'failed'; message: string }
  | { state: 'cancelled' };

export interface WaitForRestartOptions {
  /** The version the request promised (the update's new version, or the rollback target). */
  expectedVersion: string | null;
  /** The version running before the request. */
  previousVersion: string | null;
  signal: AbortSignal;
  /** Plain-language progress, called whenever the picture changes. */
  onStatus?: (text: string) => void;
  intervalMs?: number;
}

const bare = (v: string | null | undefined): string => (v ?? '').trim().replace(/^v/i, '');

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done);
  });
}

export async function waitForRestart(o: WaitForRestartOptions): Promise<RestartOutcome> {
  const interval = o.intervalMs ?? 2000;
  const expected = bare(o.expectedVersion);
  const previous = bare(o.previousVersion);
  let sawDown = false;
  let lastStatus = '';
  const say = (text: string) => { if (text !== lastStatus) { lastStatus = text; o.onStatus?.(text); } };

  say('Waiting for the server to restart...');
  while (!o.signal.aborted) {
    await sleep(interval, o.signal);
    if (o.signal.aborted) break;

    let r: Awaited<ReturnType<typeof api.getVersion>> | null = null;
    try { r = await api.getVersion(); } catch { r = null; }
    if (o.signal.aborted) break;

    if (!r || !r.ok) {
      sawDown = true;
      say('The server is restarting...');
      continue;
    }

    const running = bare(r.data.version);
    const episode = r.data.episode ?? null;
    // An episode only counts when it is about THIS request's target; an older one is history.
    const mine = episode && (expected ? bare(episode.targetVersion) === expected : true);
    if (mine && episode) {
      if (episode.phase === 'rolled-back') {
        return { state: 'failed', message: `The new version${expected ? ` (${expected})` : ''} did not start properly, so Dojo went back to ${running}. Nothing was lost; check the logs before trying again.` };
      }
      if (episode.phase === 'failed-permanently') {
        return { state: 'failed', message: `The new version${expected ? ` (${expected})` : ''} did not start and Dojo could not go back on its own. Check the machine.` };
      }
      if (episode.phase === 'interrupted') {
        return { state: 'failed', message: `The install was cut off before it changed anything. Dojo is still running ${running}.` };
      }
    }

    const arrived = expected ? running === expected : (running !== previous || sawDown);
    if (arrived) return { state: 'ready' };

    say(sawDown
      ? `The server is back but still on ${running || 'the old version'}; waiting for ${expected || 'the new version'} to finish starting...`
      : 'Waiting for the server to restart...');
  }
  return { state: 'cancelled' };
}
