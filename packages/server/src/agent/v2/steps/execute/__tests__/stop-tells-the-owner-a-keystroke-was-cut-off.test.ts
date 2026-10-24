// ════════════════════════════════════════
// v3.5 E19b — A KEYSTROKE OR A CLICK THE STOP CUT IS TOLD TO THE OWNER, LIKE EVERY OTHER ACTION.
//
// `keyboard_type` and `mouse_click` type and click on the owner's screen, yet they were classed
// `bookkeeping` (no effectful verb in their names), so when Stop cut one the owner heard nothing,
// while `mouse_move` and `applescript_run` — the same family — raised the "cut off" notice. The
// stop race decides "is this an action the owner must hear about" from that class; the class was
// the reason.
// ════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolCall } from '@dojo/shared';

const broadcasts: Array<Record<string, unknown>> = [];
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: (ev: Record<string, unknown>) => { broadcasts.push(ev); } }));

import { runUnlessStopped } from '../stop-race.js';
import { notifyUserStop } from '../../../../stop-waiters.js';
import { classifyToolResult, type ToolOutcome } from '../../../../tool-outcome.js';

const AGENT = 'e19b-hid-agent';
const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => { broadcasts.length = 0; });

async function cutByTheStop(tc: ToolCall): Promise<string | undefined> {
  let settle!: (o: ToolOutcome) => void;
  const work = new Promise<ToolOutcome>((r) => { settle = r; });
  const race = runUnlessStopped(AGENT, tc, () => work);
  notifyUserStop(AGENT);
  const r = await race;
  expect(r.stopped).toBe(true);
  if (r.stopped) expect(r.result.content).toMatch(/may already have happened/);
  // The child the Stop killed ends the handler with an error: the action did not finish.
  settle(classifyToolResult({ toolCallId: tc.id, name: tc.name, content: 'Error: ended by SIGTERM', isError: true }));
  await tick();
  const told = broadcasts.find((b) => b.type === 'chat:error' && b.agentId === AGENT);
  return told === undefined ? undefined : String(told.error);
}

describe('E19b — a screen action the Stop cut is told to the owner', () => {
  it.each([
    ['keyboard_type', { text: 'hello' }],
    ['mouse_click', { x: 10, y: 20 }],
    ['mouse_move', { x: 10, y: 20 }],
  ] as const)('%s: the owner is told it was cut off and did not finish', async (name, args) => {
    const words = await cutByTheStop({ id: `tc-${name}`, name, arguments: args } as ToolCall);
    expect(words, `the owner heard nothing after ${name} was cut`).toBe(`After you pressed Stop: ${name} was cut off and did not finish.`);
  });

  it('CONTROL: a look at the screen is not an action, so nothing is told', async () => {
    expect(await cutByTheStop({ id: 'tc-shot', name: 'screen_screenshot', arguments: {} } as ToolCall)).toBeUndefined();
  });
});
