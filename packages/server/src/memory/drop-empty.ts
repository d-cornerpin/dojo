// A message that says nothing never reaches a provider: providers reject an empty text block, so empty messages
// and blank text blocks are dropped before the assistant-row merge.
type Block = { type?: string; text?: unknown };
type Msg = { role: string; content: unknown; reasoningContent?: string };

const blank = (b: Block): boolean => b?.type === 'text' && typeof b.text === 'string' && b.text.trim() === '';

/** The messages with blank text blocks removed and messages left with nothing dropped (reasoning kept by its holder). */
export function dropEmptyMessages<T extends Msg>(messages: readonly T[]): T[] {
  const out: T[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      if (m.content.trim() === '' && !m.reasoningContent) continue;
      out.push(m);
      continue;
    }
    if (Array.isArray(m.content)) {
      const kept = (m.content as Block[]).filter((b) => !blank(b));
      if (kept.length === 0 && !m.reasoningContent) continue;
      out.push(kept.length === (m.content as Block[]).length ? m : { ...m, content: kept });
      continue;
    }
    out.push(m);
  }
  return out;
}
