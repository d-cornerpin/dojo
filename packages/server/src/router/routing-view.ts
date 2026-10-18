// ════════════════════════════════════════════════════════════════════════════════════════
// t212 (v3.4 D11) — WHAT THE ROUTER READS, TAKEN FROM THE STORE BEFORE ANYTHING IS ASSEMBLED.
//
// An auto-routed turn used to be assembled for the largest window the router opens a tier on,
// routed on that array, then assembled AGAIN for the model it dials when that model was smaller
// (`call-llm/reassemble-for-fit.ts`). The router never needed the assembly: `decide.ts` reads the
// query, whether the turn's asks carry an image, the user's previous real request (a short "yes,
// do it" inherits its tier) and, on the keyword fallback, the newest user and assistant messages.
// Each of those is a fact of the newest rows, the part every view keeps whatever its window. So
// the turn is routed on those rows, read here, and assembled once, for the model it will dial.
//
// THE VIEW, oldest first: the user's previous real request; the agent's newest reply before this
// turn's asks; this turn's asks as one user message (the assembler merges consecutive user rows
// the same way), carrying an image block when one of them has an image attached (the same rows
// `runtime.ts` `injectAttachmentBlocks` attaches images to: those since the agent's last plain
// reply). Every walk below stops on a real signal (the first reply, the first real request), never
// on a count.
//
// SCOPE: a person's turn reads its own conversation (the assembler scopes the same way); an engine
// or peer turn has no conversation id and reads the agent's own rows.
//
// LABEL, NEVER HIDE: this decides only which model answers. What the model sees is still the one
// assembly, built afterwards for that model.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { isSubstantiveRequest } from './decide.js';

export type RoutingMessage = { role: 'user' | 'assistant'; content: string | object[] };

interface Row { role: 'user' | 'assistant'; content: string; attachments: string | null }

/** An assistant row's stored content: the provider's own blocks (a tool turn), or plain text. */
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

/**
 * The routing view of `agentId`'s newest rows. `query` is the turn's authoritative ask (the trigger
 * row's text, null on an engine or peer turn). `throughSeq` bounds the read to the rows that existed
 * at an instant: the offline replay of recorded decisions reads the store as it stood then.
 */
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
  // No ask after the newest reply (an engine or peer turn woken by a note the agent already
  // answered): the turn's own trigger, else the newest ask the agent has.
  const askText = asks.length > 0 ? asks.reverse().map((r) => r.content).join('\n\n') : (scope.query ?? newestAsk ?? '');
  view.push({ role: 'user', content: image ? [{ type: 'text', text: askText }, { type: 'image' }] : askText });
  return view;
}
