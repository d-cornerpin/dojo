// v3.5 field fix 3, re-review 2. OWNER RULING "Your messages come first": while a long shell command
// runs, the owner's new message must still get answered. The command keeps running in the background;
// the agent's turn is not held waiting on it, and the agent gets the result when it ends.
//
// The exec door used to hold the call (and so the turn, and so the owner's waiting message, since owner
// messages do not preempt a turn) for as long as the command ran. Now, while a person's message is
// waiting (the one definition, `getWaitingHumanConversations`), the door hands the turn back with the
// fact, the process keeps running, and when it ends the Dojo hands its result to the agent and wakes it
// (`tellAgentAndWake`, the existing engine wake). No clock decides any of this: the child below waits on
// a file the test creates, so nothing here bets on wall time.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../effects/capability.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  requireAuthorized: () => ({ agentId: 'background-test-agent' }),
}));

import { runProcess } from '../process-run.js';

const audit = (): void => { /* not under test */ };

function gatedScript(): { script: string; release: () => void; dir: string } {
  const dir = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'bg-cmd-'));
  const flag = path.join(dir, 'go');
  return {
    dir,
    script: `while [ ! -f '${flag}' ]; do sleep 0.05; done; echo finished-late`,
    release: () => fs.writeFileSync(flag, ''),
  };
}

describe('a waiting person comes before a long command', () => {
  it('THE RED: a person writes while the command runs: the turn gets the call back at once, and the command still completes and is handed over', async () => {
    const g = gatedScript();
    let waiting = false;
    let handOver: (t: string) => void = () => {};
    const handedOver = new Promise<string>((r) => { handOver = r; });
    const run = runProcess({
      auditTarget: g.script, file: '/bin/zsh', argv: ['-c', g.script], timeout: 30_000, cwd: undefined, note: null, audit,
      personWaiting: () => waiting, whenDoneLater: (t) => handOver(t),
    } as never);
    waiting = true;                                   // the owner's message arrives mid-command
    const result = await run;                         // returns while the command is still blocked on its flag
    expect(result).toMatch(/still running in the background/);
    expect(result).toMatch(/a message from a person is waiting/);
    g.release();                                      // the command ends after the turn has moved on
    expect(await handedOver).toContain('finished-late');
    fs.rmSync(g.dir, { recursive: true, force: true });
  });

  it('CONTROL: nobody waiting: the call returns the command\'s own output when it ends, as before', async () => {
    const g = gatedScript();
    const run = runProcess({
      auditTarget: g.script, file: '/bin/zsh', argv: ['-c', g.script], timeout: 30_000, cwd: undefined, note: null, audit,
      personWaiting: () => false, whenDoneLater: () => { throw new Error('nothing is handed over later'); },
    } as never);
    g.release();
    expect(await run).toContain('finished-late');
    fs.rmSync(g.dir, { recursive: true, force: true });
  });
});
