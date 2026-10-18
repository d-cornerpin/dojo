import type { Message } from '@dojo/shared';
import { classifyMessageForDisplay } from '@dojo/shared';

/**
 * AUTO-BACKFILL (incident 2026-07-06, the blank-chat guarantee): the serving contract stays raw
 * pages + client-side visibility, but a page can legitimately contain ZERO renderable rows when
 * machine traffic (agent coordination) sits on top of the conversation. In that case do exactly
 * what a user scrolling up would do, keep fetching older pages until real conversation renders
 * (or history ends). Wordy mode renders every row, so its first page always satisfies the floor
 * immediately.
 * It ends on a real signal, never a page count (t207, no hard limits): enough renderable rows,
 * the end of history (an empty or failed page), a page that brings nothing new (a server that
 * repeats itself cannot hold the loop), or the load being cancelled. This makes "open the chat,
 * see nothing" impossible: the conversation is always dug up, however deep the machine traffic.
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
  const known = new Set(loaded.map((m) => m.id));
  while (renderableCount() < 15 && loaded.length > 0) {
    const oldest = loaded[0]?.id;
    if (!oldest) break;
    const older = await fetchOlder(oldest);
    if (!stillActive()) return null;
    if (!older.ok || !older.data || older.data.length === 0) break;
    const fresh = older.data.filter((m) => !known.has(m.id));
    if (fresh.length === 0) break;   // nothing new: history has ended as far as this server will say
    for (const m of fresh) known.add(m.id);
    loaded = [...fresh, ...loaded];
  }
  return loaded;
}
