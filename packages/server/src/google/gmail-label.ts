// ════════════════════════════════════════
// The `gmail_label` executor (moved out of tools-write.ts so that file only shrinks).
//
//   - A call that changes nothing is refused (GitHub #21): it used to POST an empty modify and
//     report success, so a worker that mis-named its arguments believed the job was done.
//   - One message / one conversation: resolved by gmail-archive.ts (t190), exactly as before.
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

  const target = await resolveGmailLabelTarget(args, gmailBase, agentId, agentName, slot);
  if (!target.ok) return target.error;

  const result = await googleWrite('POST', target.url, { addLabelIds: addLabels, removeLabelIds: removeLabels }, agentId, agentName, 'gmail_label', { messageId: target.messageId, threadId: target.threadId, addLabels, removeLabels }, undefined, slot);
  if (!result.ok) return labelFailureText(result.error, toolName);
  if (!target.conversation) return `Labels updated on message ${target.messageId}`;
  const count = (result.data as { messages?: unknown[] } | null)?.messages?.length;
  return `Labels updated on the WHOLE conversation ${target.threadId}${count ? ` (${count} message${count === 1 ? '' : 's'})` : ''}. To change only one message next time, pass message_id with this_message_only=true.`;
}
