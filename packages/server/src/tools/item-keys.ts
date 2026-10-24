// v3.5 DONE IS MEASURED: which tool calls touch which ITEMS, as stable keys for the task ledger
// (work/ledger-store.ts). The engine writes the ledger from the calls themselves, so "how many did
// this task touch" is counted, never claimed. Reads touch nothing; a tool absent here touches nothing.
//
// A key is the provider's id prefixed by its kind ("gmail:msg:<id>", "gmail:thread:<id>",
// "outlook:msg:<id>"), so a message and a conversation are never the same item.

const strs = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : typeof v === 'string' && v ? [v] : [];
const uniq = (xs: string[]): string[] => [...new Set(xs)];
const base = (name: string): string => name.startsWith('user_') ? name.slice(5) : name;

/** The per-message Outlook mutations: each takes one `message_id`. */
const OUTLOOK_MESSAGE_MUTATIONS = new Set(['outlook_move_to_folder', 'outlook_mark_read', 'outlook_delete', 'outlook_categories_set']);

/** The items a MUTATION call touches, as stable keys. Reads touch nothing. */
export function itemKeysOf(toolName: string, args: Record<string, unknown>): string[] {
  const name = base(toolName);
  if (name === 'gmail_label') {
    return uniq([
      ...strs(args.message_ids).map((id) => `gmail:msg:${id}`),
      ...strs(args.message_id).map((id) => `gmail:msg:${id}`),
      ...strs(args.thread_ids).map((id) => `gmail:thread:${id}`),
      ...strs(args.thread_id).map((id) => `gmail:thread:${id}`),
    ]);
  }
  if (OUTLOOK_MESSAGE_MUTATIONS.has(name)) return uniq(strs(args.message_id).map((id) => `outlook:msg:${id}`));
  return [];
}
