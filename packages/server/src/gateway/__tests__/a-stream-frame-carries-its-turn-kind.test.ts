// A stream frame says which kind of turn made it, so the dashboard hides an inter-agent stream from the frame itself.
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../../agent/v2/outbound.js', () => ({ recordDashboardDelivery: () => null }));

import { broadcast, onBroadcast } from '../ws.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';
import type { WsEvent } from '@dojo/shared';

const AGENT = 'agent-stream-kind';
afterEach(() => endTurnContext(AGENT));

function seen(send: () => void): WsEvent[] {
  const got: WsEvent[] = [];
  const off = onBroadcast((e) => got.push(e));
  send();
  off();
  return got;
}

const frames = (): void => {
  broadcast({ type: 'chat:chunk', agentId: AGENT, messageId: 'm1', content: 'hi', done: false });
  broadcast({ type: 'chat:reasoning_chunk', agentId: AGENT, messageId: 'm1', content: 'thinking', done: false });
  broadcast({ type: 'chat:tool_call', agentId: AGENT, tool: 'noop', args: {} });
  broadcast({ type: 'chat:tool_result', agentId: AGENT, tool: 'noop', result: 'ok' });
};

describe('a stream frame carries its turn kind', () => {
  it('every stream frame of an inter-agent turn says a2a', () => {
    openTurnContext(AGENT).kind = 'a2a';
    const got = seen(frames);
    expect(got).toHaveLength(4);
    expect(got.map((e) => (e as { turnKind?: string }).turnKind)).toEqual(['a2a', 'a2a', 'a2a', 'a2a']);
  });

  it('a frame outside any turn carries no kind', () => {
    const got = seen(frames);
    expect(got.map((e) => (e as { turnKind?: string }).turnKind)).toEqual([undefined, undefined, undefined, undefined]);
  });
});
