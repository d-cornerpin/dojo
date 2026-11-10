// After "Update Now" or a rollback, wait until the update is proven to have arrived: the
// first answer may still come from the old process, so only real signals end the wait.

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
  /** Wording only: a rollback calls its target "the version you chose". */
  kind?: 'update' | 'rollback';
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

  // Words only, never a cut-off: after a few minutes the status says how long and where to look.
  const startedAt = Date.now();
  const waited = () => {
    const min = Math.floor((Date.now() - startedAt) / 60_000);
    return min >= 3 ? ` Still waiting after ${min} minutes. If Dojo does not come back, the menu bar app shows what the watchdog found.` : '';
  };
  say('Waiting for the server to restart...');
  while (!o.signal.aborted) {
    await sleep(interval, o.signal);
    if (o.signal.aborted) break;

    let r: Awaited<ReturnType<typeof api.getVersion>> | null = null;
    try { r = await api.getVersion(); } catch { r = null; }
    if (o.signal.aborted) break;

    if (!r || !r.ok) {
      sawDown = true;
      say(`The server is restarting...${waited()}`);
      continue;
    }

    const running = bare(r.data.version);
    // Arrival decides first: the expected version running is success whatever a leftover marker says.
    if (expected ? running === expected : (running !== previous || sawDown)) return { state: 'ready' };

    // Failure is only read from an episode that belongs to THIS request, which needs a known target.
    const episode = r.data.episode ?? null;
    if (episode && expected && bare(episode.targetVersion) === expected) {
      const what = o.kind === 'rollback' ? `The version you chose (${expected})` : `The new version (${expected})`;
      if (episode.phase === 'rolled-back') {
        return { state: 'failed', message: `${what} did not start properly, so Dojo went back to ${running}. Nothing was lost; check the logs before trying again.` };
      }
      if (episode.phase === 'failed-permanently') {
        return { state: 'failed', message: `${what} did not start and Dojo could not go back on its own. Check the machine.` };
      }
      if (episode.phase === 'interrupted') {
        return { state: 'failed', message: `The install was cut off before it changed anything. Dojo is still running ${running}.` };
      }
    }
    say(sawDown
      ? `The server is back but still on ${running || 'the old version'}; waiting for ${expected || 'the new version'} to finish starting...${waited()}`
      : `Waiting for the server to restart...${waited()}`);
  }
  return { state: 'cancelled' };
}
