// The main agent runs administrator commands at once, through every door: no hold, no card, no refusal.

import { describe, it, expect, vi } from 'vitest';

const PRIMARY = 'primary-agent';
vi.mock('../../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../../config/platform.js')>()),
  isPrimaryAgent: (id: string) => id === PRIMARY,
}));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));

const { authorizeExecShapedCall } = await import('../exec-seam.js');
const { authorizeAppleScript } = await import('../applescript.js');
const { resolveCommandArg } = await import('../resolve.js');
const { grantForManifest } = await import('../grants.js');
const { PRIMARY_AGENT_PERMISSIONS } = await import('../../manifest.js');
const { recordDispatchAndHold } = await import('../../v2/steps/execute/dispatch-bookkeeping.js');
const { initState } = await import('../../v2/state.js');

const main = grantForManifest(PRIMARY, PRIMARY_AGENT_PERMISSIONS);
const LINES = ['sudo brew services restart postgresql', 'sudo -i', 'sudo -p "pw:" cp a b', 'echo $(sudo whoami)', 'true; sudo ls /var/root', 'su root -c "ls /"', 'osascript ~/Scripts/cleanup.scpt'];

describe('the main agent is never held or refused for sudo', () => {
  it('the broker allows every spelling at both doors', () => {
    for (const line of LINES) expect(authorizeExecShapedCall(main, 'shell', line).allowed, line).toBe(true);
    expect(authorizeExecShapedCall(main, 'proc', ['sudo', 'launchctl', 'kickstart', 'system/com.example.x']).allowed).toBe(true);
  });

  it('an AppleScript asking for administrator privileges is allowed', () => {
    const r = resolveCommandArg('do shell script "launchctl list" with administrator privileges');
    expect(r.ok && authorizeAppleScript(main, r.value).allowed).toBe(true);
  });

  it('dispatch holds nothing: no card, the call goes on to run', async () => {
    const state = initState({
      agentId: PRIMARY, contextWindow: 200_000, isAutoRouted: false, configuredModelId: 'test', turnNumber: 1,
      triggeredByIMessage: false, triggeredByA2AReplyIntent: null, lastUserMessageContent: null, lastUserMessageId: null,
      inboundChannel: null, inboundContext: null,
    });
    const out = await recordDispatchAndHold(state, ({ id: 't1', name: 'shell', arguments: { script: 'sudo whoami' } } as never), ({ agentId: PRIMARY, db: null } as never));
    expect(out.refusal).toBeNull();
  });

  it('the main agent cannot be talked out of the keys file by sudo', () => {
    for (const line of ['sudo cat ~/.dojo/secrets.yaml', 'su root -c "cat ~/.dojo/secrets.yaml"']) {
      expect(authorizeExecShapedCall(main, 'shell', line).allowed, line).toBe(false);
    }
  });
});
