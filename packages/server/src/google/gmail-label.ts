// ════════════════════════════════════════
// The `gmail_label` executor (moved out of tools-write.ts so that file only shrinks).
//
//   - A call that changes nothing is refused (GitHub #21): it used to POST an empty modify and
//     report success, so a worker that mis-named its arguments believed the job was done.
//   - One message / one conversation: resolved by gmail-archive.ts (t190), exactly as before.
//   - Many (v3.5, B3): `message_ids` go through Gmail's batchModify in chunks of 1,000 (its documented
//     maximum); `thread_ids` go one threads.modify each (Gmail has no thread batch). A chunk that fails
//     does not stop the others, and the Error names the ids that were NOT changed. Batch labels the
//     messages named, one by one: it does not widen an archive to the whole conversation (pass
//     `thread_ids` for that), so a mailbox count taken per message reaches zero.
// ════════════════════════════════════════

import { googleWrite } from './client.js';
import { resolveGmailLabelTarget } from './gmail-archive.js';

/** The refusal for a call with nothing to add and nothing to remove. */
export const NOTHING_TO_CHANGE =
  'Error: nothing to change — pass add_labels and/or remove_labels (arrays of label names). ' +
  'Target one message with message_id, several with message_ids, a conversation with thread_id, several with thread_ids. ' +
  'Any other argument name is not read by this tool.';

/**
 * A bare Gmail 400 ("Invalid label: Junk E-mail") has no remedy: point the agent at the lister and
 * creator with the SAME prefix as the tool as called (`toolName`), so a user_ call is never sent to
 * a base tool it cannot use.
 */
export function labelFailureText(error: string | undefined, toolName: string): string {
  if (/invalid label/i.test(error ?? '')) {
    const prefix = toolName.startsWith('user_') ? 'user_' : '';
    const listerTool = `${prefix}gmail_list_labels`;
    const createTool = `${prefix}gmail_create_label`;
    return (
      `Error modifying labels: ${error}. That label does not exist on this Gmail account ` +
      `(label names are per-account, not shared). Call ${listerTool} to see the account's actual label ` +
      'names before retrying — do not guess or invent one. Two common cases already have a standard label: ' +
      'to archive a message, remove_labels: ["INBOX"] (there is no separate "Archive" label to add); to ' +
      'mark it as junk/spam, add_labels the system label "SPAM". If you intended a genuinely new custom ' +
      `label, call ${createTool} first, then retry gmail_label with the exact name it returns.`
    );
  }
  return `Error modifying labels: ${error}`;
}

export async function executeGmailLabel(
  toolName: string,
  args: Record<string, unknown>,
  gmailBase: string,
  agentId: string,
  agentName: string,
  slot: string,
): Promise<string> {
  const addLabels = (args.add_labels as string[]) ?? [];
  const removeLabels = (args.remove_labels as string[]) ?? [];
  if (addLabels.length === 0 && removeLabels.length === 0) return NOTHING_TO_CHANGE;

  const messageIds = idList(args.message_ids);
  const threadIds = idList(args.thread_ids);
  if (messageIds.length > 0 || threadIds.length > 0) {
    return executeBatch(toolName, args, gmailBase, addLabels, removeLabels, messageIds, threadIds, agentId, agentName, slot);
  }

  const target = await resolveGmailLabelTarget(args, gmailBase, agentId, agentName, slot);
  if (!target.ok) return target.error;

  const result = await googleWrite('POST', target.url, { addLabelIds: addLabels, removeLabelIds: removeLabels }, agentId, agentName, 'gmail_label', { messageId: target.messageId, threadId: target.threadId, addLabels, removeLabels }, undefined, slot);
  if (!result.ok) return labelFailureText(result.error, toolName);
  if (!target.conversation) return `Labels updated on message ${target.messageId}`;
  const count = (result.data as { messages?: unknown[] } | null)?.messages?.length;
  return `Labels updated on the WHOLE conversation ${target.threadId}${count ? ` (${count} message${count === 1 ? '' : 's'})` : ''}. To change only one message next time, pass message_id with this_message_only=true.`;
}

/** Gmail's documented maximum ids per `messages.batchModify` call. */
const BATCH_MODIFY_IDS = 1000;

const idList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []);
const unique = (xs: string[]): string[] => [...new Set(xs)];
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

async function executeBatch(
  toolName: string,
  args: Record<string, unknown>,
  gmailBase: string,
  addLabels: string[],
  removeLabels: string[],
  messageIds: string[],
  threadIds: string[],
  agentId: string,
  agentName: string,
  slot: string,
): Promise<string> {
  const messages = unique([...messageIds, ...idList([args.message_id])]);
  const threads = unique([...threadIds, ...idList([args.thread_id])]);
  const labelBody = { addLabelIds: addLabels, removeLabelIds: removeLabels };
  const doneMessages: string[] = [];
  const doneThreads: string[] = [];
  const failedMessages: string[] = [];
  const failedThreads: string[] = [];
  const errors: string[] = [];

  for (let i = 0; i < messages.length; i += BATCH_MODIFY_IDS) {
    const chunk = messages.slice(i, i + BATCH_MODIFY_IDS);
    const r = await googleWrite('POST', `${gmailBase}/messages/batchModify`, { ids: chunk, ...labelBody }, agentId, agentName, 'gmail_label', { messageIds: chunk, addLabels, removeLabels }, undefined, slot);
    if (r.ok) doneMessages.push(...chunk);
    else { failedMessages.push(...chunk); errors.push(r.error ?? 'unknown error'); }
  }
  for (const threadId of threads) {
    const r = await googleWrite('POST', `${gmailBase}/threads/${encodeURIComponent(threadId)}/modify`, labelBody, agentId, agentName, 'gmail_label', { threadId, addLabels, removeLabels }, undefined, slot);
    if (r.ok) doneThreads.push(threadId);
    else { failedThreads.push(threadId); errors.push(r.error ?? 'unknown error'); }
  }

  const done: string[] = [];
  if (doneMessages.length) done.push(`${plural(doneMessages.length, 'message', 'messages')} (ids ${doneMessages.join(', ')})`);
  if (doneThreads.length) done.push(`${plural(doneThreads.length, 'conversation', 'conversations')} (thread ids ${doneThreads.join(', ')})`);
  const archivesMessages = doneMessages.length > 0 && removeLabels.some((l) => String(l).toUpperCase() === 'INBOX');
  if (errors.length === 0) {
    return `Labels updated on ${done.join(' and ')}.` +
      (archivesMessages ? ' Each message was changed on its own; other messages in the same conversations keep their labels (use thread_ids to change whole conversations).' : '');
  }

  const notDone: string[] = [];
  if (failedMessages.length) notDone.push(`${plural(failedMessages.length, 'message', 'messages')} (ids ${failedMessages.join(', ')})`);
  if (failedThreads.length) notDone.push(`${plural(failedThreads.length, 'conversation', 'conversations')} (thread ids ${failedThreads.join(', ')})`);
  return (
    labelFailureText(unique(errors).join('; '), toolName) +
    (done.length ? `\nThe change WAS applied to ${done.join(' and ')}.` : '') +
    `\nIt was NOT changed on ${notDone.join(' and ')}; retry those.`
  );
}
