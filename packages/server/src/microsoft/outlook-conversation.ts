// Outlook archives whole conversations. A mail thread is one conversation to the owner, so a move into the
// archive or deleted items takes the whole conversation (a message's `conversationId`), as Gmail does.
//   conversation_id: every message of it (to the archive or deleted items, Sent Items and Drafts stay).
//   message_id + archive/deleted-items folder, no `this_message_only`: the messages of its conversation in
//     the SAME folder as it; a failed id or folder lookup moves nothing, never a silent one-message move.
//   anything else: that one message.
// The conversation is listed first (every page), then moved through Graph `$batch`; nothing moves if the
// list could not be read.

import { msGraphRead, msGraphWrite } from './client.js';

/** Graph's documented limit on requests inside one `$batch` call. */
const GRAPH_BATCH_SIZE = 20;

/** Graph's well-known folder names that mean "this conversation is put away". */
const PUT_AWAY_FOLDERS = ['archive', 'deleteditems'] as const;

export interface OutlookCallContext { agentId: string; agentName: string; slot: string }

/** The `Conversation:` line the reads print, or nothing when Graph sent no id. */
export const conversationLine = (id: string | undefined, lead = '\n'): string => (id ? `${lead}Conversation: ${id}` : '');

/** Is this folder one whose move takes the whole conversation: named, or the id of that folder?
 *  null when Graph would not say whether the id is one of them. */
async function isPutAwayFolder(folderId: string, ctx: OutlookCallContext): Promise<boolean | null> {
  if ((PUT_AWAY_FOLDERS as readonly string[]).includes(folderId.toLowerCase())) return true;
  // A folder id from outlook_list_folders: ask Graph which ids the two well-known names stand for.
  const ids = await Promise.all(PUT_AWAY_FOLDERS.map(async (name) => {
    const r = await msGraphRead(`me/mailFolders/${name}?$select=id`, ctx.agentId, ctx.agentName, 'outlook_move_to_folder:folder_lookup', { name }, ctx.slot);
    return r.ok ? (r.data as { id?: string } | null)?.id : undefined;
  }));
  const lookedUp = ids.filter((id): id is string => typeof id === 'string');
  if (lookedUp.includes(folderId)) return true;
  // A failed lookup means we cannot tell "not a put-away folder" from "Graph would not say".
  return lookedUp.length === ids.length ? false : null;
}

/** The ids of the Sent Items and Drafts folders (once per call); null if Graph would not say. */
async function sentAndDraftFolders(ctx: OutlookCallContext): Promise<Set<string> | null> {
  const ids = await Promise.all(['sentitems', 'drafts'].map(async (name) => {
    const r = await msGraphRead(`me/mailFolders/${name}?$select=id`, ctx.agentId, ctx.agentName, 'outlook_move_to_folder:folder_lookup', { name }, ctx.slot);
    return r.ok ? (r.data as { id?: string } | null)?.id : undefined;
  }));
  return ids.every(Boolean) ? new Set(ids as string[]) : null;
}

async function conversationOf(messageId: string, ctx: OutlookCallContext): Promise<{ ok: true; id: string; folder: string } | { ok: false; error: string }> {
  const found = await msGraphRead(
    `me/messages/${encodeURIComponent(messageId)}?$select=conversationId,parentFolderId`,
    ctx.agentId, ctx.agentName, 'outlook_move_to_folder:conversation_lookup', { messageId }, ctx.slot,
  );
  const data = found.data as { conversationId?: string; parentFolderId?: string } | null;
  const id = data?.conversationId;
  const folder = data?.parentFolderId;
  if (!found.ok || !id || !folder) {
    return {
      ok: false,
      error: `Error: could not find the conversation for message ${messageId} (${found.error ?? 'no conversation id or folder returned'}), so nothing was moved. ` +
        'Retry, or pass this_message_only=true to move just that one message.',
    };
  }
  return { ok: true, id, folder };
}

async function listConversation(conversationId: string, ctx: OutlookCallContext): Promise<{ ok: true; found: Array<{ id: string; folder?: string }> } | { ok: false; error: string }> {
  const value = conversationId.replace(/'/g, "''");
  let next: string | undefined = `me/messages?$filter=${encodeURIComponent(`conversationId eq '${value}'`)}&$select=id,parentFolderId`;
  const found: Array<{ id: string; folder?: string }> = [];
  const seen = new Set<string>();
  while (next && !seen.has(next)) {
    seen.add(next);
    const page = await msGraphRead(next, ctx.agentId, ctx.agentName, 'outlook_move_to_folder:conversation_list', { conversationId }, ctx.slot);
    if (!page.ok) return { ok: false, error: page.error ?? 'unknown error' };
    const data = page.data as { value?: Array<{ id: string; parentFolderId?: string }>; '@odata.nextLink'?: string } | null;
    for (const m of data?.value ?? []) found.push({ id: m.id, folder: m.parentFolderId });
    next = data?.['@odata.nextLink'];
  }
  return { ok: true, found };
}

/** `include`: which messages (by their folder id) move; absent = every message. */
async function moveConversation(conversationId: string, folderId: string, ctx: OutlookCallContext, include?: (folder: string | undefined) => boolean): Promise<string> {
  const listed = await listConversation(conversationId, ctx);
  if (!listed.ok) {
    return `Error: could not list the conversation (${listed.error}), so nothing was moved. Retry, or pass message_id with this_message_only=true to move just one message.`;
  }
  const ids = listed.found.filter((m) => !include || include(m.folder)).map((m) => m.id);
  const left = listed.found.length - ids.length;
  if (ids.length === 0) return `Error: that conversation has no messages to move (conversation_id ${conversationId}); nothing was moved.`;

  let moved = 0;
  const failures: string[] = [];
  for (let i = 0; i < ids.length; i += GRAPH_BATCH_SIZE) {
    const group = ids.slice(i, i + GRAPH_BATCH_SIZE);
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
  const total = ids.length;
  const stayed = left > 0 ? ` ${left} other message${left === 1 ? '' : 's'} of it in other folders (sent copies, drafts) ${left === 1 ? 'was' : 'were'} left where ${left === 1 ? 'it is' : 'they are'}.` : '';
  if (failures.length === 0) return `Moved the WHOLE conversation (${total} message${total === 1 ? '' : 's'}) to folder ${folderId}. Their old message IDs are no longer valid.${stayed}`;
  // The engine reads failure from the first word (agent/tools/index.ts), so a partly-moved conversation
  // leads with `Error: `.
  return `Error: Moved ${moved} of ${total} messages of the conversation to folder ${folderId}; ${failures.length} could not be moved (${[...new Set(failures)].join('; ')}). Call again with conversation_id=${conversationId} to move the rest.${stayed}`;
}

/** `outlook_move_to_folder`: one message, or a whole conversation (see the header). */
export async function moveToFolder(args: Record<string, unknown>, ctx: OutlookCallContext): Promise<string> {
  const folderId = args.folder_id as string;
  const messageId = typeof args.message_id === 'string' && args.message_id ? args.message_id : undefined;
  const given = typeof args.conversation_id === 'string' && args.conversation_id ? args.conversation_id : undefined;
  if (!messageId && !given) return 'Error: pass message_id (one email) or conversation_id (a whole conversation).';
  if (messageId && given) return 'Error: pass message_id or conversation_id, not both.';

  if (given) {
    const putAway = await isPutAwayFolder(folderId, ctx);
    if (putAway === null) return 'Error: could not tell whether that folder is the Archive or Deleted Items (Graph would not say), so nothing was moved. Retry, or pass the folder name archive or deleteditems.';
    if (!putAway) return moveConversation(given, folderId, ctx);
    const own = await sentAndDraftFolders(ctx);
    if (!own) return 'Error: could not identify the Sent Items and Drafts folders (so they cannot be left alone), and nothing was moved. Retry, or move one message with message_id and this_message_only=true.';
    return moveConversation(given, folderId, ctx, (f) => !f || !own.has(f));
  }
  const putAway = messageId && args.this_message_only !== true && (await isPutAwayFolder(folderId, ctx));
  if (putAway === null) return 'Error: could not tell whether that folder is the Archive or Deleted Items (Graph would not say), so nothing was moved. Retry, or pass the folder name archive or deleteditems.';
  if (putAway) {
    const found = await conversationOf(messageId, ctx);
    if (!found.ok) return found.error;
    return moveConversation(found.id, folderId, ctx, (f) => f === found.folder);
  }

  const result = await msGraphWrite('POST', `me/messages/${encodeURIComponent(messageId!)}/move`, { destinationId: folderId },
    ctx.agentId, ctx.agentName, 'outlook_move_to_folder', { messageId, folderId }, ctx.slot);
  if (!result.ok) return `Error moving email: ${result.error}`;
  const data = result.data as { id?: string };
  return `Email moved to folder ${folderId}${data?.id ? ` (new message ID: ${data.id})` : ''}`;
}
