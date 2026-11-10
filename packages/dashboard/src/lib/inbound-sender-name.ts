/** A Teams row's stored sender display name wins; older or other rows keep the parsed SOURCE label. */
export function inboundSenderName(inboundMeta: string | null | undefined, parsed: string | null): string | null {
  try {
    const name = inboundMeta ? (JSON.parse(inboundMeta) as { senderName?: unknown }).senderName : undefined;
    if (typeof name === 'string' && name.trim() !== '') return name.trim();
  } catch { /* an unreadable record: the parsed label */ }
  return parsed;
}
