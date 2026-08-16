// UX-REPAIR ROUND 11 · T43 leg (c) — THE DECLARATION.
//
// W30 stood this leg down partly because it PROVED the undeclared form does not work: passing
// `hands_off_thread` without declaring it produced
//
//   [Engine warning: "send_to_agent" was called with arg(s) not in its schema,
//    "hands_off_thread". These were silently ignored…]
//
// on the very call the footer instructs — the engine telling the model its hand-off did
// nothing. So the argument is DECLARED, at the cost of cacheable-prefix bytes, as a registered
// re-blessing (the kit golden moves once, and the added property is its only cause).
//
// These clauses live here rather than in the transport test because
// `agent/tools/definitions.ts` pulls the Google/Microsoft definition modules, whose import
// graph reaches `gateway/ws.js` and collides with that file's mock of it.

import { describe, it, expect } from 'vitest';
import { getAllToolDefinitions } from '../definitions.js';

const def = () => getAllToolDefinitions().find((d) => d.name === 'send_to_agent')!;
const props = () => def().input_schema.properties as Record<string, { type?: string; description?: string }>;

describe('send_to_agent declares the hand-off argument', () => {
  it('the argument is DECLARED, so the engine cannot tell the model it was ignored', () => {
    expect(props().hands_off_thread).toBeDefined();
    expect(props().hands_off_thread.type).toBe('string');
    expect((props().hands_off_thread.description ?? '').length).toBeGreaterThan(0);
  });

  it('it is OPTIONAL — every call that works today still works', () => {
    expect(def().input_schema.required).toEqual(['agent', 'intent', 'payload']);
  });

  it('the declaration names its ONE precondition and the alternative when the work cannot be done', () => {
    const d = props().hands_off_thread.description ?? '';
    // Only an assignee handing work ON has anything to re-point…
    expect(d).toMatch(/assign/i);
    // …and the honest exit when it cannot be done at all is FAIL, not a note that reads as
    // the finished work. That is the same alternative the hop-cap refusal names.
    expect(d).toContain('FAIL');
  });

  it('THE PREFIX COST IS BOUNDED — exactly one property was added to this tool', () => {
    // The registered re-blessing's whole cause. If a second property ever rides along, the
    // golden move stops being explained by this task and this clause says so.
    expect(Object.keys(props()).sort()).toEqual(
      ['agent', 'attach_paths', 'hands_off_thread', 'intent', 'payload', 'requires_response', 'thread_id'],
    );
  });

  it('the tool DESCRIPTION is untouched — the prefix delta is the property alone', () => {
    // The description is the far bigger string; keeping it byte-identical is what makes the
    // golden's delta small enough to read in one diff.
    expect(def().description).toContain('**USE THIS TOOL when responding to any inbound message');
    expect(def().description).not.toContain('hands_off_thread');
  });
});
