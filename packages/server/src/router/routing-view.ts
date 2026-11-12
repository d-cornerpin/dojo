// What the router reads, taken from the store before anything is assembled: the user's previous real
// request, the agent's newest reply before this turn's asks, and this turn's asks as one user message
// (with an image block when one has an image attached, as `injectAttachmentBlocks` does). Walks stop on
// a real signal, never on a count. A person's turn reads its own conversation; an engine or peer turn
// reads the agent's rows. The view only decides which model answers; the model still sees the one assembly.

import { getDb } from '../db/connection.js';
import { isSubstantiveRequest } from './decide.js';

export type RoutingMessage = { role: 'user' | 'assistant'; content: string | object[] };

interface Row { role: 'user' | 'assistant'; content: string; attachments: string | null }

function assistantContent(content: string): string | object[] {
  if (!content.startsWith('[')) return content;
  try {
    const blocks = JSON.parse(content) as unknown;
    return Array.isArray(blocks) ? blocks as object[] : content;
  } catch { return content; }
}

function hasToolUse(content: string | object[]): boolean {
  return Array.isArray(content) && content.some((b) => (b as { type?: string }).type === 'tool_use');
}

/** An attached image (the category `injectAttachmentBlocks` turns into an image block). */
function carriesImage(attachments: string | null): boolean {
  if (!attachments) return false;
  try {
    const list = JSON.parse(attachments) as Array<{ category?: string }>;
    return Array.isArray(list) && list.some((a) => a.category === 'image');
  } catch { return false; }
}

/** The routing view of `agentId`'s newest rows; `query` is the turn's own ask, `throughSeq` bounds the read. */
export function routingView(agentId: string, scope: { conversationId: string | null; query: string | null; throughSeq?: number }): RoutingMessage[] {
  const rows = getDb().prepare(`
    SELECT role, content, attachments FROM messages
    WHERE agent_id = ? AND role IN ('user', 'assistant')
      AND (? IS NULL OR conversation_id = ?) AND (? IS NULL OR seq <= ?)
    ORDER BY seq DESC
  `).iterate(agentId, scope.conversationId, scope.conversationId, scope.throughSeq ?? null, scope.throughSeq ?? null) as IterableIterator<Row>;

  const asks: Row[] = [];
  let reply: string | object[] | null = null;
  let turnOpen = true;          // still inside this turn: no plain reply met yet
  let image = false;
  let prior: string | null = null;
  let newestAsk: string | null = null;
  for (const row of rows) {
    if (row.role === 'assistant') {
      const content = assistantContent(row.content);
      if (reply === null) reply = content;
      if (!hasToolUse(content)) turnOpen = false;
    } else {
      newestAsk ??= row.content;
      if (turnOpen && carriesImage(row.attachments)) image = true;
      if (reply === null) asks.push(row);
      else if (prior === null && isSubstantiveRequest(row.content, scope.query ?? '')) prior = row.content;
    }
    if (prior !== null && !turnOpen) break;
  }

  const view: RoutingMessage[] = [];
  if (prior !== null) view.push({ role: 'user', content: prior });
  if (reply !== null) view.push({ role: 'assistant', content: reply });
  // No ask after the newest reply (engine or peer turn): the turn's trigger, else the newest ask.
  const askText = asks.length > 0 ? asks.reverse().map((r) => r.content).join('\n\n') : (scope.query ?? newestAsk ?? '');
  view.push({ role: 'user', content: image ? [{ type: 'text', text: askText }, { type: 'image' }] : askText });
  return view;
}
