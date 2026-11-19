// Watchers' "already notified" list (`*_notified_<account>` in `config`), saved after EACH message acted on:
// a poll that throws part-way must not make the next poll re-read the same messages.
import { setConfigValue } from '../config/config-value.js';

/** The most mails one poll of a mail watcher handles. */
export const MAX_MAILS_PER_POLL = 500;
/** Twice one poll's bound: a mail handled in the last two polls is still known when a look back lists it again. */
const KEPT_IDS = 2 * MAX_MAILS_PER_POLL;

export function persistNotifiedIds(key: string, ids: ReadonlySet<string>): void {
  const value = JSON.stringify([...ids].slice(-KEPT_IDS));
  setConfigValue(key, value);
}
