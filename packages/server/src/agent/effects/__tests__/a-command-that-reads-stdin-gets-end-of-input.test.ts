// A command the agent runs gets no input: anything reading stdin sees end of input at once instead of
// waiting until its idle bound.
import { describe, it, expect, vi } from 'vitest';
import { runWithToolCallId } from '../../turn-state.js';
import { attachCallCapability, mintCallCapability, type ResourceGrant } from '../capability.js';
import { runWithIdleBound } from '../../tools/process-idle-bound.js';

vi.mock('../../../db/connection.js', () => ({ getDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined, run: () => ({ changes: 0 }) }) }) }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => undefined }));

const AGENT = 'stdin-agent';

function inCall<T>(program: string, body: () => Promise<T>): Promise<T> {
  const grants: ResourceGrant[] = [{ kind: 'proc', program, display: program } as ResourceGrant];
  return runWithToolCallId(AGENT, 'call-1', async () => {
    attachCallCapability(mintCallCapability({ agentId: AGENT, tool: 'exec', callId: 'call-1', grants }));
    return body();
  });
}

describe('a command that reads stdin', () => {
  it('ends at once with what it read, nothing, instead of hitting its idle bound', async () => {
    const started = Date.now();
    const out = await inCall('/bin/sh', () => runWithIdleBound('/bin/sh', ['-c', 'cat; echo read-done'], { idleMs: 5_000 }));
    expect(out.stdout.trim()).toBe('read-done');
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});
