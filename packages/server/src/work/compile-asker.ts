// Who asked, for the compile steer (`join-drive.ts`): the relay delivers to the ask's own sender.

/** Who asked, when the ask did not come from the owner on the dashboard. */
export interface CompileAsker { readonly name: string; readonly channel: string | null }

/**
 * Who asked, from the ask row's inbound stamp. Null means the owner (dashboard, voice, owner relation,
 * or no stamp): the steer keeps saying "the owner". `displayName` turns a raw handle into a name.
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
