import type { Message } from '@dojo/shared';
import { classifyMessageForDisplay } from '@dojo/shared';

/**
 * A page can hold zero renderable rows when machine traffic sits on top, so keep fetching older
 * pages as a user scrolling up would until real conversation renders or history ends. It stops
 * on a real signal, never a page count. Returns null when the load is cancelled; caller drops it.
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
