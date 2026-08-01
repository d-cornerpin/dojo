// PHASE-3 T6 — the lane tag. Every clause here is a property the mechanism DEPENDS on;
// the two that matter most are the JSON invisibility (a tag that reached a provider would
// be a cache-prefix law violation on every message) and the survival across the exact
// array operations the assembler and the loop perform between emission and the wire.
import { describe, it, expect } from 'vitest';
import {
  tagMessageLane,
  tagMessageLanes,
  messageLaneOf,
  collectMessageLaneIds,
} from '../message-lane-tag.js';

type Msg = { role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> };
const m = (role: Msg['role'], content: Msg['content']): Msg => ({ role, content });

describe('message lane tag', () => {
  it('records and reads back a lane id', () => {
    const a = tagMessageLane(m('user', 'hello'), 'lane.fresh-tail');
    expect(messageLaneOf(a)).toBe('lane.fresh-tail');
  });

  it('an untagged message reads null, never a guess', () => {
    expect(messageLaneOf(m('user', '═══ MORNING BRIEFING ═══'))).toBeNull();
    expect(messageLaneOf(null)).toBeNull();
    expect(messageLaneOf(undefined)).toBeNull();
  });

  it('THE FIRST TAG WINS — a later generic pass cannot overwrite a specific emitter', () => {
    const a = tagMessageLane(m('user', 'x'), 'msg.turn-context');
    tagMessageLane(a, 'lane.fresh-tail');
    expect(messageLaneOf(a)).toBe('msg.turn-context');
  });

  // ── the property the whole design rests on ──
  it('IS INVISIBLE TO JSON — a tag can never reach a provider or move a golden', () => {
    const a = tagMessageLane(m('user', 'hello'), 'lane.fresh-tail');
    const plain = m('user', 'hello');
    expect(JSON.stringify(a)).toBe(JSON.stringify(plain));
    expect(Object.keys(a)).toEqual(Object.keys(plain));
    expect(JSON.stringify([a])).toBe(JSON.stringify([plain]));
  });

  it('survives object SPREAD — the shape sanitizeToolBlocks and the integrity pass use', () => {
    const a = tagMessageLane(m('user', [{ type: 'tool_result' }]), 'lane.fresh-tail');
    const copy = { ...a, content: [{ type: 'text' }] };
    expect(messageLaneOf(copy)).toBe('lane.fresh-tail');
  });

  it('survives filter / splice / shift / push — the array operations the loop performs', () => {
    const msgs = [
      tagMessageLane(m('user', 'a'), 'lane.briefing'),
      tagMessageLane(m('user', 'b'), 'lane.fresh-tail'),
      tagMessageLane(m('user', 'c'), 'lane.events'),
    ];
    const filtered = msgs.filter((x) => x.content !== 'b');
    expect(collectMessageLaneIds(filtered)).toEqual(['lane.briefing', 'lane.events']);

    const spliced = [...msgs];
    const [moved] = spliced.splice(0, 1);
    spliced.push(moved);
    expect(collectMessageLaneIds(spliced)).toEqual(['lane.fresh-tail', 'lane.events', 'lane.briefing']);

    const shifted = [...msgs];
    shifted.shift();
    expect(collectMessageLaneIds(shifted)).toEqual(['lane.fresh-tail', 'lane.events']);
  });

  it('collectMessageLaneIds is ALIGNED BY CONSTRUCTION — misalignment is not expressible', () => {
    const msgs = [m('user', 'a'), tagMessageLane(m('assistant', 'b'), 'lane.scaffolding-ack')];
    const ids = collectMessageLaneIds(msgs);
    expect(ids).toHaveLength(msgs.length);
    expect(ids).toEqual([null, 'lane.scaffolding-ack']);
  });

  it('tagMessageLanes tags a whole group and returns it', () => {
    const group = [m('user', 'a'), m('assistant', 'b')];
    expect(collectMessageLaneIds(tagMessageLanes(group, 'lane.summaries'))).toEqual([
      'lane.summaries', 'lane.summaries',
    ]);
  });
});
