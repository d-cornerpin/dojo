// A helper's AppleScript whose shell line deletes recursively waits for the main agent's approval, as
// the same line at the shell door does. Driven through the turn loop's dispatch step; nothing runs.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../../approval-decision.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), deliverGateWake: async () => true }));

const { scratchDojo, HELPER } = await import('../../../../tools/__tests__/scratch-dojo.js');
const { home, dispatch } = await scratchDojo('applescript-hold');

describe('an AppleScript rm -rf from a helper is held for the main agent', () => {
  it('is held', async () => {
    expect((await dispatch(HELPER, 'applescript_run', { script: `do shell script "rm -rf ${home}/old-build"` }))?.content).toContain('[HELD by engine');
  });

  it('an AppleScript with no deleting shell line is not held', async () => {
    expect(await dispatch(HELPER, 'applescript_run', { script: 'do shell script "ls -l /tmp"' })).toBeNull();
  });
});
