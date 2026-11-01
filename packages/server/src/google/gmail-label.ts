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

import { googleRead, googleWrite } from './client.js';
import { resolveGmailLabelTarget } from './gmail-archive.js';
import { BATCH_MODIFY_IDS } from './gmail-limits.js';

/** The refusal for a call with nothing to add and nothing to remove. */
export const NOTHING_TO_CHANGE =
  'Error: nothing to change — pass add_labels and/or remove_labels (arrays of label names). ' +
  'Target one message with message_id, several with message_ids, a conversation with thread_id, several with thread_ids. ' +
  'Any other argument name is not read by this tool.';

/**
 * The plain failure text. A bare Gmail 400 ("Invalid label: Junk E-mail") gets its remedy from
 * `tools/error-remedies.ts`, which the engine appends to the failing result (same-prefix lister and
 * creator for a `user_` call included).
 */
export function labelFailureText(error: string | undefined, _toolName: string): string {
  // The remedy for an invalid label lives in tools/error-remedies.ts; the engine appends it to the failing result.
  return `Error modifying labels: ${error}`;
}

// Gmail's modify calls take label IDs only, but the tool tells the agent to pass a custom label's NAME.
// A system label (INBOX, STARRED, CATEGORY_PROMOTIONS ...) and a custom id (Label_123) already are ids.
const ALREADY_AN_ID = /^(?:[A-Z][A-Z_]*|Label_\d+)$/;

/** Turn custom label names into this account's label ids. A name that matches nothing, or a label list that cannot be read, is left as given so Gmail's own refusal (and its remedy) still applies. */
async function labelIdsFor(labels: string[], gmailBase: string, agentId: string, agentName: string, slot: string): Promise<string[]> {
  if (labels.every((l) => ALREADY_AN_ID.test(l))) return labels;
  const listed = await googleRead(`${gmailBase}/labels`, agentId, agentName, 'gmail_label', {}, slot);
  const all = (listed?.ok ? (listed.data as { labels?: Array<{ id: string; name: string }> } | null)?.labels : undefined) ?? [];
  return labels.map((l) => {
    if (ALREADY_AN_ID.test(l)) return l;
    const byId = all.find((x) => x.id === l);
    if (byId) return byId.id;
    return all.find((x) => x.name === l)?.id ?? all.find((x) => x.name.toLowerCase() === l.toLowerCase())?.id ?? l;
  });
}

export async function executeGmailLabel(
  toolName: string,
  args: Record<string, unknown>,
  gmailBase: string,
  agentId: string,
  agentName: string,
  slot: string,
): Promise<string> {
  const askedAdd = (args.add_labels as string[]) ?? [];
  const askedRemove = (args.remove_labels as string[]) ?? [];
  if (askedAdd.length === 0 && askedRemove.length === 0) return NOTHING_TO_CHANGE;
  const resolved = await labelIdsFor([...askedAdd, ...askedRemove], gmailBase, agentId, agentName, slot);
  const addLabels = resolved.slice(0, askedAdd.length);
  const removeLabels = resolved.slice(askedAdd.length);

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

const idList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []);
const unique = (xs: string[]): string[] => [...new Set(xs)];
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The two sentences of a partial-apply failure. The writer (`executeBatch`) and the reader
 *  (`appliedKeysOf`) share these constants so they cannot drift. */
export const APPLIED_PHRASE = 'The change WAS applied to ';
export const NOT_CHANGED_PHRASE = '\nIt was NOT changed on ';

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
    (done.length ? `\n${APPLIED_PHRASE}${done.join(' and ')}.` : '') +
    `${NOT_CHANGED_PHRASE}${notDone.join(' and ')}; retry those.`
  );
}

/** The ids a partial-apply failure says WERE applied, as ledger keys (`gmail:msg:<id>`,
 *  `gmail:thread:<id>`), in text order. Null when the text claims nothing was applied.
 *  The engine sets `isError` from the first word (agent/tools/index.ts), so a call that
 *  changed 1,000 of 1,250 ids is an Error result; this is how what it DID changed is
 *  recovered for the task ledger (work/ledger-store.ts). */
export function appliedKeysOf(content: string): string[] | null {
  const at = content.indexOf(APPLIED_PHRASE);
  if (at === -1) return null;
  const from = at + APPLIED_PHRASE.length;
  const end = content.indexOf(NOT_CHANGED_PHRASE, from);
  const applied = content.slice(from, end === -1 ? undefined : end);
  const keys: string[] = [];
  for (let pos = 0; pos < applied.length; ) {
    const t = applied.indexOf('(thread ids ', pos);
    const m = applied.indexOf('(ids ', pos);
    const g = t === -1 ? m : m === -1 ? t : Math.min(t, m); // "(thread ids " before "(ids "
    if (g === -1) break;
    const thread = g === t;
    const open = (thread ? '(thread ids ' : '(ids ').length;
    const body = applied.slice(g + open);
    const close = body.indexOf(')');
    if (close === -1) break;
    for (const id of body.slice(0, close).split(', ').map((x) => x.trim())) {
      if (id) keys.push(`${thread ? 'gmail:thread' : 'gmail:msg'}:${id}`);
    }
    pos = g + open + close + 1;
  }
  return keys;
}
