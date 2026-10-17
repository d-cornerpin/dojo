import type { Message } from '@dojo/shared';
import { classifyMessageForDisplay } from '@dojo/shared';

/**
 * AUTO-BACKFILL (incident 2026-07-06, the blank-chat guarantee): the serving contract stays raw
 * pages + client-side visibility, but a page can legitimately contain ZERO renderable rows when
 * machine traffic (agent coordination) sits on top of the conversation. In that case do exactly
 * what a user scrolling up would do, keep fetching older pages until real conversation renders
 * (or history ends). Wordy mode renders every row, so its first page always satisfies the floor
 * immediately.
 * Bounded: 60 extra pages of 200 covers a pathological 12k-row pileup in a few seconds of
 * background fetches; past that, the scroll-up path continues as always. After a user updates,
 * this makes "open the chat, see nothing" impossible, their conversation is always dug up.
 *
 * Returns the rows to show, or `null` when `stillActive()` went false (the load was cancelled
 * because the agent changed): the caller then drops the result.
 */
export async function backfillUntilRenderable(
  first: Message[],
  wordyMode: boolean,
  fetchOlder: (oldestId: string) => Promise<{ ok: boolean; data?: Message[] }>,
  stillActive: () => boolean,
): Promise<Message[] | null> {
  let loaded = first;
  const rendersInRegular = (m: Message) =>
    m.role === 'system'
      ? false
      : (m.role !== 'user' && m.role !== 'assistant')
        ? false
        : classifyMessageForDisplay(m).tier === 'user-visible';
  const renderableCount = () => (wordyMode ? loaded.length : loaded.filter(rendersInRegular).length);
  let backfills = 0;
  while (renderableCount() < 15 && loaded.length > 0 && backfills < 60) {
    const oldest = loaded[0]?.id;
    if (!oldest) break;
    const older = await fetchOlder(oldest);
    if (!stillActive()) return null;
    if (!older.ok || !older.data || older.data.length === 0) break;
    loaded = [...older.data, ...loaded];
    backfills++;
  }
  return loaded;
}
