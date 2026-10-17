// ════════════════════════════════════════
// Which Gmail object a `gmail_label` call acts on (t190, C2; owner ruling: archive acts on the
// WHOLE conversation by default).
//
// Gmail's inbox is per-conversation: a thread stays in the inbox while ANY message in it
// carries INBOX. Removing INBOX from one message ("archive") therefore left the conversation
// where it was, and the junk reappeared. `threads/<id>/modify` is covered by the existing
// `gmail.modify` scope, so no reconnect is needed.
//
//   thread_id              -> that conversation, directly.
//   message_id + INBOX removal (archive), no `this_message_only`
//                          -> the message's WHOLE conversation (its thread id is looked up;
//                             a failed lookup is an error, never a silent one-message change).
//   message_id, any other label change, or `this_message_only`
//                          -> that one message, exactly as before.
// ════════════════════════════════════════

import { googleRead } from './client.js';

export type LabelTarget =
  | { ok: true; url: string; conversation: boolean; messageId?: string; threadId?: string }
  | { ok: false; error: string };

export async function resolveGmailLabelTarget(
  args: Record<string, unknown>,
  gmailBase: string,
  agentId: string,
  agentName: string,
  slot: string,
): Promise<LabelTarget> {
  const messageId = typeof args.message_id === 'string' && args.message_id ? args.message_id : undefined;
  const threadId = typeof args.thread_id === 'string' && args.thread_id ? args.thread_id : undefined;
  if (!messageId && !threadId) return { ok: false, error: 'Error: pass message_id (one email) or thread_id (a whole conversation).' };
  if (messageId && threadId) return { ok: false, error: 'Error: pass message_id or thread_id, not both.' };
  const modify = (kind: 'threads' | 'messages', id: string) => `${gmailBase}/${kind}/${encodeURIComponent(id)}/modify`;
  if (threadId) return { ok: true, url: modify('threads', threadId), conversation: true, threadId };

  const removes = (args.remove_labels as string[] | undefined) ?? [];
  const archives = removes.some((l) => String(l).toUpperCase() === 'INBOX');
  if (!archives || args.this_message_only === true) {
    return { ok: true, url: modify('messages', messageId!), conversation: false, messageId };
  }
  const found = await googleRead(
    `${gmailBase}/messages/${encodeURIComponent(messageId!)}?format=minimal`,
    agentId, agentName, 'gmail_label:thread_lookup', { messageId }, slot,
  );
  const tid = (found.data as { threadId?: string } | null)?.threadId;
  if (!found.ok || !tid) {
    return {
      ok: false,
      error: `Error: could not find the conversation for message ${messageId} (${found.error ?? 'no thread id returned'}), so nothing was archived. ` +
        'Retry, or pass this_message_only=true to archive just that one message.',
    };
  }
  return { ok: true, url: modify('threads', tid), conversation: true, messageId, threadId: tid };
}
