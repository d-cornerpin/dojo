// Within one turn the array only grows, so the cached prefix holds: a later call resends the previous
// array plus new rows, this call's steers, changed blocks (labelled) and notices for emptied blocks.
// It goes out fresh when sent history changed, the model changed, the append does not fit, or the memo
// was forgotten (`model-call.ts`: retry, fallback, re-fit). The memo is a WeakMap on the turn object.

import type { ModelCallParams } from '../../../model.js';
import { messageLaneOf, tagMessageLane } from '../../../../memory/message-lane-tag.js';

type ModelMessage = ModelCallParams['messages'][number];

/** The label on a block sent again because it changed. One line, one bracket pair. */
export const UPDATE_LABEL = '[update · this replaces the earlier copy of this section, above, which is now out of date]';
/** The label on a block that went empty. The block's own first line follows it, to name it. */
export const EMPTIED_LABEL = '[update · the section that starts with the line below was shown earlier in this turn and is now empty; that earlier copy no longer applies]';

interface TurnArray {
  /** The previous call's conversation region (`[0, volatileFrom)` of its fresh array), serialised. */
  history: string[];
  sent: ModelMessage[];
  /** Per block occurrence: the newest text the sent array shows for it ('' = shown as emptied). */
  shown: Map<string, string>;
  /** The turn's first allocator boundary: the receipt's cross-turn cacheable region. */
  firstVolatileFrom: number;
  modelId: string;
}

const turns = new WeakMap<object, TurnArray>();

/** Called when a call went out with something other than the array this module returned. */
export function forgetTurnArray(turn: object): void {
  turns.delete(turn);
}

export interface AppendInput {
  readonly turn: object;
  readonly loopCount: number;
  readonly modelId: string;
  readonly fresh: ModelMessage[];
  readonly volatileFrom: number;
  /** Where the state blocks begin in `fresh`; the one-shot steers sit between the two. */
  readonly blocksFrom: number;
  /** Whether an array fits the room of the model about to be dialed. Asked only when appending. */
  readonly fits: (messages: ModelMessage[]) => Promise<boolean>;
}

export interface AppendOutput {
  readonly messages: ModelMessage[];
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
