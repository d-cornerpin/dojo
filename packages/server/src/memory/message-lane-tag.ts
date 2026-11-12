// Which lane made a message, on a symbol key: spread, filter and splice carry it; JSON.stringify skips it,
// so no provider or receipt hash sees it. Untagged is null, never a guess: it flags an unowned injection.

const LANE_TAG = Symbol.for('dojo.messageLaneId');

type TaggableMessage = object;

/** The first tag wins, so a later generic pass never overwrites the specific id an emitter recorded. */
export function tagMessageLane<T extends TaggableMessage>(msg: T, laneId: string): T {
  if (msg == null) return msg;
  const holder = msg as Record<symbol, unknown>;
  if (typeof holder[LANE_TAG] === 'string') return msg;
  holder[LANE_TAG] = laneId;
  return msg;
}

export function tagMessageLanes<T extends TaggableMessage>(msgs: readonly T[], laneId: string): readonly T[] {
  for (const m of msgs) tagMessageLane(m, laneId);
  return msgs;
}

export function messageLaneOf(msg: TaggableMessage | null | undefined): string | null {
  if (msg == null) return null;
  const v = (msg as Record<symbol, unknown>)[LANE_TAG];
  return typeof v === 'string' ? v : null;
}

export function collectMessageLaneIds(messages: readonly TaggableMessage[]): (string | null)[] {
  return messages.map((m) => messageLaneOf(m));
}
