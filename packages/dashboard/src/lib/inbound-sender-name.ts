/** v3.5 K33 fix round 4: the name an inbound badge shows. A Teams row stores its sender's display
 *  name in the message record (the model reads it only inside the fence); any other row, or an
 *  older one, keeps the label parsed from its SOURCE line. */
export function inboundSenderName(inboundMeta: string | null | undefined, parsed: string | null): string | null {
  try {
    const name = inboundMeta ? (JSON.parse(inboundMeta) as { senderName?: unknown }).senderName : undefined;
    if (typeof name === 'string' && name.trim() !== '') return name.trim();
  } catch { /* an unreadable record: the parsed label */ }
  return parsed;
}
