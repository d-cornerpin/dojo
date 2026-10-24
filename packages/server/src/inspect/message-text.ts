// v3.5 inspect B1 — a stored message's content as a person would read it.
//
// A `messages.content` cell is either plain text or the provider-shaped JSON block array the
// loop stores for tool work. A tool call reads as "calls <tool> <input>", a tool result as
// "<tool> (ok|error): <text>" — the tool's name comes from the call that the result answers,
// which the caller collects from the rows it has (`toolNamesIn`).

interface Block { type?: string; text?: unknown; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown }

function blocksOf(content: string): Block[] | null {
  if (!content.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(content) as unknown;
    return Array.isArray(parsed) && parsed.every((b) => b && typeof b === 'object' && typeof (b as Block).type === 'string') ? parsed as Block[] : null;
  } catch { return null; }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b && typeof b === 'object' && typeof (b as Block).text === 'string' ? (b as Block).text as string : '')).filter(Boolean).join('\n');
  return '';
}

/** tool call id → tool name, over every block-array row given. */
export function toolNamesIn(contents: readonly string[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const c of contents) for (const b of blocksOf(c) ?? []) {
    if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') names.set(b.id, b.name);
  }
  return names;
}

/** The readable text of one stored message. */
export function messageText(content: string, toolNames: Map<string, string> = new Map()): string {
  const blocks = blocksOf(content);
  if (!blocks) return content;
  return blocks.map((b) => {
    if (b.type === 'text') return typeof b.text === 'string' ? b.text : '';
    if (b.type === 'tool_use') return `calls ${String(b.name)} ${JSON.stringify(b.input ?? {})}`;
    if (b.type === 'tool_result') {
      const name = typeof b.tool_use_id === 'string' ? toolNames.get(b.tool_use_id) ?? 'tool' : 'tool';
      return `${name} (${b.is_error ? 'error' : 'ok'}): ${resultText(b.content)}`;
    }
    return `[${b.type}]`;
  }).filter(Boolean).join('\n');
}

/** The tool name and text of every FAILED tool result in one stored message (K37: the timeline
 *  prints each one's error fingerprint). Empty for plain text and for results that succeeded. */
export function failedResults(content: string, toolNames: Map<string, string> = new Map()): Array<{ tool: string; text: string }> {
  return (blocksOf(content) ?? [])
    .filter((b) => b.type === 'tool_result' && b.is_error)
    .map((b) => ({ tool: typeof b.tool_use_id === 'string' ? toolNames.get(b.tool_use_id) ?? 'tool' : 'tool', text: resultText(b.content) }));
}
