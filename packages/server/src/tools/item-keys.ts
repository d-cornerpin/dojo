// v3.5 DONE IS MEASURED: which tool calls touch which ITEMS, as stable keys for the task ledger
// (work/ledger-store.ts). The engine writes the ledger from the calls themselves, so "how many did
// this task touch" is counted, never claimed. Reads touch nothing; a tool absent here touches nothing.
//
// A key is the provider's id prefixed by its kind ("gmail:msg:<id>", "gmail:thread:<id>",
// "outlook:msg:<id>", "outlook:conv:<id>"), so a message and a conversation are never the same item.
//
// v3.5 field fix 3 (#6a): the worker's non-mailbox work, from each tool's own declared effects
// (`agent/tools/types.ts`, conformance-checked against its schema): a file it writes or deletes is
// "file:<path>", a command it runs is "cmd:<the command>". The caller hands the effects in, so this
// module stays a leaf. Only an `args.` effect names its resource; a `derived:` one cannot be read here.
import type { ToolEffect } from '../agent/tools/types.js';

/** The two non-mailbox prefixes. A `cmd:` entry is a record of work, never an item (see ledger-store). */
export const FILE_KEY = 'file:';
export const COMMAND_KEY = 'cmd:';

const strs = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : typeof v === 'string' && v ? [v] : [];
const uniq = (xs: string[]): string[] => [...new Set(xs)];
const base = (name: string): string => name.startsWith('user_') ? name.slice(5) : name;

/** The per-message Outlook mutations: each takes one `message_id`. */
const OUTLOOK_MESSAGE_MUTATIONS = new Set(['outlook_move_to_folder', 'outlook_mark_read', 'outlook_delete', 'outlook_categories_set']);

/** The value an `args.<path>` effect names: a dotted path, `[]` for array elements. */
function argValues(args: Record<string, unknown>, from: string): unknown[] {
  if (!from.startsWith('args.')) return [];
  let cursor: unknown[] = [args];
  for (const seg of from.slice('args.'.length).split('.')) {
    const many = seg.endsWith('[]');
    const key = many ? seg.slice(0, -2) : seg;
    cursor = cursor.flatMap((c) => {
      const v = c !== null && typeof c === 'object' ? (c as Record<string, unknown>)[key] : undefined;
      return many ? (Array.isArray(v) ? v : []) : [v];
    });
  }
  return cursor;
}

/** The command text a `proc` / `shell` argument names: an argv array joined, or a script as written. */
function commandText(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')) return (v as string[]).join(' ').trim() || null;
  return null;
}

/** The files and commands a call's declared effects name, as ledger keys. */
function effectKeysOf(args: Record<string, unknown>, effects: readonly ToolEffect[]): string[] {
  const out: string[] = [];
  for (const e of effects) {
    if (e.kind === 'fs_write' || e.kind === 'fs_delete') {
      for (const v of argValues(args, e.from)) if (typeof v === 'string' && v.trim()) out.push(`${FILE_KEY}${v.trim()}`);
    } else if (e.kind === 'proc' || e.kind === 'shell') {
      for (const v of argValues(args, e.from)) { const c = commandText(v); if (c) out.push(`${COMMAND_KEY}${c}`); }
    }
  }
  return out;
}

/** The items a MUTATION call touches, as stable keys. Reads touch nothing. `effects`: the tool's own
 *  declared effects, for its file and command work. */
export function itemKeysOf(toolName: string, args: Record<string, unknown>, effects: readonly ToolEffect[] = []): string[] {
  return uniq([...mailboxKeysOf(toolName, args), ...effectKeysOf(args, effects)]);
}

/** The mailbox items a call touches. */
function mailboxKeysOf(toolName: string, args: Record<string, unknown>): string[] {
  const name = base(toolName);
  if (name === 'gmail_label') {
    return uniq([
      ...strs(args.message_ids).map((id) => `gmail:msg:${id}`),
      ...strs(args.message_id).map((id) => `gmail:msg:${id}`),
      ...strs(args.thread_ids).map((id) => `gmail:thread:${id}`),
      ...strs(args.thread_id).map((id) => `gmail:thread:${id}`),
    ]);
  }
  // The move tool alone can take the whole conversation instead of, or beside, one message.
  if (name === 'outlook_move_to_folder') {
    return uniq([
      ...strs(args.message_id).map((id) => `outlook:msg:${id}`),
      ...strs(args.conversation_id).map((id) => `outlook:conv:${id}`),
    ]);
  }
  if (OUTLOOK_MESSAGE_MUTATIONS.has(name)) return uniq(strs(args.message_id).map((id) => `outlook:msg:${id}`));
  return [];
}
