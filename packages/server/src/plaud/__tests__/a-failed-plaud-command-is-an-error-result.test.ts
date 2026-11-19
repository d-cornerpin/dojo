// When the Plaud program fails (a network error, a server error), the tool result is an error result,
// so the agent and the engine both see that nothing was read.

import { describe, it, expect, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: (_file: string, _args: string[], _opts: unknown, cb: (err: unknown) => void) => {
    cb(Object.assign(new Error('Command failed: plaud files'), { code: 1, stdout: '', stderr: 'server error 500' }));
  },
  spawn: () => { throw new Error('not used in this test'); },
}));
vi.mock('../auth.js', () => ({ isPlaudConnected: () => true, notePlaudReauthRequired: () => {} }));
vi.mock('../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../config/platform.js')>()),
  isPrimaryAgent: () => true,
}));

const { plaudHandlers } = await import('../../agent/tools/provider/plaud.js');

describe('a failed Plaud command', () => {
  it('comes back as an error result that starts with "Error:"', async () => {
    const out = await plaudHandlers.plaud_list_recordings({ agentId: 'agent-main', name: 'plaud_list_recordings', args: {} } as never);
    expect(out.isError).toBe(true);
    expect(out.content.startsWith('Error:')).toBe(true);
    expect(out.content).toContain('Plaud');
  });
});
