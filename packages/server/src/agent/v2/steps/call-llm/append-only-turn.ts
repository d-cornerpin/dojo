// ════════════════════════════════════════════════════════════════════════════════════════
// t210 (owner decision 37) — WITHIN ONE TURN, THE ARRAY ONLY GROWS.
//
// THE COST IT REMOVES (t206 item 2, re-derived from 221 main-agent receipts): the loop builds
// every call's array from scratch, so a later call's new tool rows land between the
// conversation and the post-tail block (task list, events, turn context, open commitments,
// the clock...). The block MOVES even when nothing in it changed, and the provider re-bills
// it and everything behind it: 128 of ~170 later calls broke exactly there, ~2.6K tokens a call.
//
// THE RULE (decision 37: "append-only within a turn ... the same 'label, never hide' approach"):
//   call 1 of a turn goes out as built. A later call sends
//     [what the previous call sent] + [the conversation rows that are new since]
//     + [this call's one-shot steers] + [each block whose text CHANGED, labelled as replacing
//       the copy above] + [a notice for each block that went EMPTY, before the clock].
//   The older copy of a block stays exactly where it was, so the cached prefix holds through
//   the end of the previous call. An unchanged block is not sent again.
//
// WHEN IT GOES OUT FRESH INSTEAD (each is a real signal, never a count):
//   - the conversation region did not simply GROW: a fold, a trim or a re-rendered row
//     changed something the previous call already sent (94% of later calls on the dev box
//     DO simply grow: 162 of 172);
//   - the appended array does not fit the room of the model about to be dialed;
//   - the model about to be dialed is not the one the previous call went to (t212: a re-route
//     mid-turn; the previous array was built for, and cached by, the other model);
//   - the call is a retry, a fallback or a re-fit (`model-call.ts` forgets the memo).
// A fresh call starts the memo again, so the next call appends to it.
//
// THE MEMO lives exactly as long as the turn's own context object (a WeakMap keyed on it), so
// nothing carries across turns: every turn's first call is built from scratch, as before.
// ════════════════════════════════════════════════════════════════════════════════════════

import type { ModelCallParams } from '../../../model.js';
import { messageLaneOf, tagMessageLane } from '../../../../memory/message-lane-tag.js';

type ModelMessage = ModelCallParams['messages'][number];

/** The label on a block sent again because it changed. One line, one bracket pair (t141). */
export const UPDATE_LABEL = '[update · this replaces the earlier copy of this section, above, which is now out of date]';
/** The label on a block that went empty. The block's own first line follows it, to name it. */
export const EMPTIED_LABEL = '[update · the section that starts with the line below was shown earlier in this turn and is now empty; that earlier copy no longer applies]';

interface TurnArray {
  /** The previous call's conversation region (`[0, volatileFrom)` of its fresh array), serialised. */
  history: string[];
  /** The array the previous call sent. */
  sent: ModelMessage[];
  /** Per block occurrence: the newest text the sent array shows for it ('' = shown as emptied). */
  shown: Map<string, string>;
  /** The turn's first allocator boundary: the receipt's cross-turn cacheable region. */
  firstVolatileFrom: number;
  /** The model the previous call was sent to. */
  modelId: string;
}

const turns = new WeakMap<object, TurnArray>();

/** Called when a call went out with something other than the array this module returned. */
export function forgetTurnArray(turn: object): void {
  turns.delete(turn);
}

export interface AppendInput {
  /** The turn's own context object; the memo lives exactly as long as it. */
  readonly turn: object;
  readonly loopCount: number;
  /** The model this call dials. */
  readonly modelId: string;
  /** This call's array, built from scratch (every injection already pushed). */
  readonly fresh: ModelMessage[];
  /** Where the allocator's region ends in `fresh`. */
  readonly volatileFrom: number;
  /** Where the state blocks begin in `fresh`; the one-shot steers sit between the two. */
  readonly blocksFrom: number;
  /** Whether an array fits the room of the model about to be dialed. Asked only when appending. */
  readonly fits: (messages: ModelMessage[]) => Promise<boolean>;
}

export interface AppendOutput {
  readonly messages: ModelMessage[];
  /** The receipt's boundary: the turn's FIRST allocator boundary on an appended call. */
  readonly volatileFrom: number;
  readonly appended: boolean;
}

const textOf = (m: ModelMessage): string => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));

/** Each block's key is its lane id plus its occurrence, so a lane that emits two messages keeps both. */
function keyed(blocks: ModelMessage[]): Array<{ m: ModelMessage; key: string | null; id: string | null }> {
  const seen = new Map<string, number>();
  return blocks.map((m) => {
    const id = messageLaneOf(m);
    if (!id) return { m, key: null, id };
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    return { m, key: `${id}#${n}`, id };
  });
}

function labelled(label: string, body: string, id: string | null, role: ModelMessage['role']): ModelMessage {
  const msg = { role, content: `${label}\n${body}` } as ModelMessage;
  return id ? tagMessageLane(msg, id) : msg;
}

export async function appendOnlyTurn(input: AppendInput): Promise<AppendOutput> {
  const { turn, fresh, volatileFrom, blocksFrom, modelId } = input;
  const history = fresh.slice(0, volatileFrom).map((m) => JSON.stringify(m));
  const blocks = keyed(fresh.slice(blocksFrom));
  const goFresh = (): AppendOutput => {
    const shown = new Map(blocks.flatMap((b) => (b.key ? [[b.key, textOf(b.m)] as const] : [])));
    turns.set(turn, { history, sent: fresh, shown, firstVolatileFrom: volatileFrom, modelId });
    return { messages: fresh, volatileFrom, appended: false };
  };

  const prev = input.loopCount > 1 ? turns.get(turn) : undefined;
  if (!prev || prev.modelId !== modelId || history.length < prev.history.length || prev.history.some((h, i) => h !== history[i])) return goFresh();

  const out = [...prev.sent, ...fresh.slice(prev.history.length, volatileFrom), ...fresh.slice(volatileFrom, blocksFrom)];
  const shown = new Map(prev.shown);
  const present = new Set(blocks.map((b) => b.key));
  const flushEmptied = () => {
    for (const [key, text] of shown) {
      if (text === '' || present.has(key)) continue;
      out.push(labelled(EMPTIED_LABEL, text.split('\n')[0], key.slice(0, key.lastIndexOf('#')), 'user'));
      shown.set(key, '');
    }
  };
  blocks.forEach((b, i) => {
    // The tail's order keeps the clock last, so the emptied notices go just ahead of it.
    if (i === blocks.length - 1) flushEmptied();
    if (!b.key) { out.push(b.m); return; }
    const text = textOf(b.m);
    const before = shown.get(b.key);
    if (before === text) return;
    out.push(before === undefined || typeof b.m.content !== 'string' ? b.m : labelled(UPDATE_LABEL, text, b.id, b.m.role));
    shown.set(b.key, text);
  });
  if (blocks.length === 0) flushEmptied();
  // A call never ends on the model's own message: the newest block rides last if nothing else did.
  if (out[out.length - 1]?.role === 'assistant' && blocks.length > 0) {
    const last = blocks[blocks.length - 1];
    out.push(typeof last.m.content === 'string' ? labelled(UPDATE_LABEL, textOf(last.m), last.id, last.m.role) : last.m);
  }

  if (!(await input.fits(out))) return goFresh();
  turns.set(turn, { history, sent: out, shown, firstVolatileFrom: prev.firstVolatileFrom, modelId });
  return { messages: out, volatileFrom: prev.firstVolatileFrom, appended: true };
}
