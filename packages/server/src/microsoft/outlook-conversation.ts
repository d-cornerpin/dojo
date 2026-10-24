// ════════════════════════════════════════
// Outlook archives whole conversations (v3.5, E20).
//
// A mail thread is one conversation to the owner: archiving a single reply left the rest of it in
// the inbox and the thread came back. Gmail already archives the whole conversation by default
// (google/gmail-archive.ts); Outlook's name for the same idea is a message's `conversationId`.
//
//   conversation_id          -> that conversation, to any folder.
//   message_id + the archive or deleted-items folder, no `this_message_only`
//                            -> the message's WHOLE conversation (its id is looked up; a failed
//                               lookup moves nothing, never a silent one-message move).
//   message_id, any other folder, or `this_message_only`
//                            -> that one message, exactly as before.
//
// The conversation is listed first (following every page to its end), then moved through Graph
// `$batch`. Nothing is moved if the list could not be read.
// ════════════════════════════════════════

import { msGraphRead, msGraphWrite } from './client.js';

/** Graph's documented limit on requests inside one `$batch` call. */
const GRAPH_BATCH_SIZE = 20;

/** Graph's well-known folder names that mean "this conversation is put away". */
const PUT_AWAY_FOLDERS = ['archive', 'deleteditems'] as const;

export interface OutlookCallContext { agentId: string; agentName: string; slot: string }

/** The `Conversation:` line the reads print, or nothing when Graph sent no id. */
export const conversationLine = (id: string | undefined, lead = '\n'): string => (id ? `${lead}Conversation: ${id}` : '');

/** Is this folder one whose move takes the whole conversation: named, or the id of that folder? */
async function isPutAwayFolder(folderId: string, ctx: OutlookCallContext): Promise<boolean> {
  if ((PUT_AWAY_FOLDERS as readonly string[]).includes(folderId.toLowerCase())) return true;
  // A folder id from outlook_list_folders: ask Graph which ids the two well-known names stand for.
  const ids = await Promise.all(PUT_AWAY_FOLDERS.map(async (name) => {
    const r = await msGraphRead(`me/mailFolders/${name}?$select=id`, ctx.agentId, ctx.agentName, 'outlook_move_to_folder:folder_lookup', { name }, ctx.slot);
    return r.ok ? (r.data as { id?: string } | null)?.id : undefined;
  }));
  return ids.includes(folderId);
}

async function conversationIdOf(messageId: string, ctx: OutlookCallContext): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const found = await msGraphRead(
    `me/messages/${encodeURIComponent(messageId)}?$select=conversationId`,
    ctx.agentId, ctx.agentName, 'outlook_move_to_folder:conversation_lookup', { messageId }, ctx.slot,
  );
  const id = (found.data as { conversationId?: string } | null)?.conversationId;
  if (!found.ok || !id) {
    return {
      ok: false,
      error: `Error: could not find the conversation for message ${messageId} (${found.error ?? 'no conversation id returned'}), so nothing was moved. ` +
        'Retry, or pass this_message_only=true to move just that one message.',
    };
  }
  return { ok: true, id };
}

/** Every message id in a conversation, paging to the end. */
async function listConversation(conversationId: string, ctx: OutlookCallContext): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  const value = conversationId.replace(/'/g, "''");
  let next: string | undefined = `me/messages?$filter=${encodeURIComponent(`conversationId eq '${value}'`)}&$select=id`;
  const ids: string[] = [];
  const seen = new Set<string>();
  while (next && !seen.has(next)) {
    seen.add(next);
    const page = await msGraphRead(next, ctx.agentId, ctx.agentName, 'outlook_move_to_folder:conversation_list', { conversationId }, ctx.slot);
    if (!page.ok) return { ok: false, error: page.error ?? 'unknown error' };
    const data = page.data as { value?: Array<{ id: string }>; '@odata.nextLink'?: string } | null;
    for (const m of data?.value ?? []) ids.push(m.id);
    next = data?.['@odata.nextLink'];
  }
  return { ok: true, ids };
}

async function moveConversation(conversationId: string, folderId: string, ctx: OutlookCallContext): Promise<string> {
  const listed = await listConversation(conversationId, ctx);
  if (!listed.ok) {
    return `Error: could not list the conversation (${listed.error}), so nothing was moved. Retry, or pass message_id with this_message_only=true to move just one message.`;
  }
  if (listed.ids.length === 0) return `Error: that conversation has no messages to move (conversation_id ${conversationId}); nothing was moved.`;

  let moved = 0;
  const failures: string[] = [];
  for (let i = 0; i < listed.ids.length; i += GRAPH_BATCH_SIZE) {
    const group = listed.ids.slice(i, i + GRAPH_BATCH_SIZE);
    const requests = group.map((id, k) => ({
      id: String(k + 1), method: 'POST', url: `/me/messages/${encodeURIComponent(id)}/move`,
      headers: { 'Content-Type': 'application/json' }, body: { destinationId: folderId },
    }));
    const sent = await msGraphWrite('POST', '$batch', { requests }, ctx.agentId, ctx.agentName, 'outlook_move_to_folder',
      { conversationId, folderId, messages: group.length }, ctx.slot);
    if (!sent.ok) { failures.push(sent.error ?? 'the batch call failed'); continue; }
    const responses = (sent.data as { responses?: Array<{ id: string; status: number; body?: { error?: { message?: string } } }> } | null)?.responses ?? [];
    for (const req of requests) {
      const r = responses.find((x) => x.id === req.id);
      if (r && r.status >= 200 && r.status < 300) moved += 1;
      else failures.push(r?.body?.error?.message ?? `HTTP ${r?.status ?? 'no answer'}`);
    }
  }
  const total = listed.ids.length;
  if (failures.length === 0) return `Moved the WHOLE conversation (${total} message${total === 1 ? '' : 's'}) to folder ${folderId}. Their old message IDs are no longer valid.`;
  return `Moved ${moved} of ${total} messages of the conversation to folder ${folderId}; ${failures.length} could not be moved (${[...new Set(failures)].join('; ')}). Call again with conversation_id=${conversationId} to move the rest.`;
}

/** `outlook_move_to_folder`: one message, or a whole conversation (see the header). */
export async function moveToFolder(args: Record<string, unknown>, ctx: OutlookCallContext): Promise<string> {
  const folderId = args.folder_id as string;
  const messageId = typeof args.message_id === 'string' && args.message_id ? args.message_id : undefined;
  const given = typeof args.conversation_id === 'string' && args.conversation_id ? args.conversation_id : undefined;
  if (!messageId && !given) return 'Error: pass message_id (one email) or conversation_id (a whole conversation).';
  if (messageId && given) return 'Error: pass message_id or conversation_id, not both.';

  let conversationId = given;
  if (messageId && args.this_message_only !== true && await isPutAwayFolder(folderId, ctx)) {
    const found = await conversationIdOf(messageId, ctx);
    if (!found.ok) return found.error;
    conversationId = found.id;
  }
  if (conversationId) return moveConversation(conversationId, folderId, ctx);

  const result = await msGraphWrite('POST', `me/messages/${encodeURIComponent(messageId!)}/move`, { destinationId: folderId },
    ctx.agentId, ctx.agentName, 'outlook_move_to_folder', { messageId, folderId }, ctx.slot);
  if (!result.ok) return `Error moving email: ${result.error}`;
  const data = result.data as { id?: string };
  return `Email moved to folder ${folderId}${data?.id ? ` (new message ID: ${data.id})` : ''}`;
}
