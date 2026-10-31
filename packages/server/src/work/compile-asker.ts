// 3.5: who asked, for the compile steer (`join-drive.ts`). The relay delivers the compiled reply to the
// ASK's own sender, so the steer names that person and channel, not always "the owner".

/** Who asked, when the ask did not come from the owner on the dashboard (3.5). */
export interface CompileAsker { readonly name: string; readonly channel: string | null }

/**
 * Who asked, read from the ask row's own inbound stamp. Null = the owner on the dashboard or
 * by voice (or an owner-stamped channel message, or no stamp at all): the steer keeps saying
 * "the owner". `displayName` turns the channel's raw handle into a name.
 */
export function compileAskerFromMeta(
  inboundMeta: string | null,
  displayName: (channel: string, handle: string) => string,
  channelWords: (channel: string) => string,
): CompileAsker | null {
  let meta: { channel?: string; sender?: string; senderName?: string; relation?: string } = {};
  try { meta = inboundMeta ? JSON.parse(inboundMeta) as typeof meta : {}; } catch { return null; }
  if (!meta.channel || meta.channel === 'dashboard' || meta.channel === 'voice' || meta.relation === 'owner') return null;
  const name = meta.senderName ?? (meta.sender ? displayName(meta.channel, meta.sender) : 'the person who asked');
  return { name, channel: channelWords(meta.channel) };
}
