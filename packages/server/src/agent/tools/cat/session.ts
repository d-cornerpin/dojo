// ════════════════════════════════════════════════════════════════════════════
// TUNNEL, PRESENCE AND SESSION RESET: each acts on the DOJO's own state, not on a
// document, a person or another agent.
// ── `reset_session` IS DELIBERATELY NOT A DOJO-CONTROL ──
// `PRIMARY_ONLY_TOOLS` omits it: the Healer (a NON-primary service agent)
// legitimately calls the reset TOOL on a wedged agent, so it stays executable while
// surface-stripped; that distinction belongs to a gate, not to this file.
// ════════════════════════════════════════════════════════════════════════════

import { isPrimaryAgent } from '../../../config/platform.js';
import { resolveAgentRef } from '../../tool-helpers.js';
import { resetSession } from '../../reset-session.js';
import { getTunnelStatus, startTunnel, stopTunnel } from '../../../services/tunnel.js';
import { setPresence, getPresence } from '../../../services/presence.js';
import type { ToolHandlerMap } from '../handler.js';

export const sessionHandlers: ToolHandlerMap = {
  async "tunnel"({ agentId, args }) {
    let content = '';
    let isError = false;
    const action = args.action as 'status' | 'start' | 'stop' | 'restart' | undefined;
    if (!action || !['status', 'start', 'stop', 'restart'].includes(action)) {
      content = 'Error: tunnel requires action to be one of: status, start, stop, restart.';
      isError = true;
      return { content, isError };
    }
    // Mutating actions stay primary-only; `status` is open to all.
    if (action !== 'status' && !isPrimaryAgent(agentId)) {
      content = `Permission denied: only the primary agent can ${action} the tunnel. You can still use tunnel({action:"status"}).`;
      isError = true;
      return { content, isError };
    }
    try {
      if (action === 'status') {
        const status = getTunnelStatus();
        if (!status.cloudflaredInstalled) {
          content = 'cloudflared is not installed. Install with: brew install cloudflare/cloudflare/cloudflared';
        } else if (status.status === 'active' && status.url) {
          content = `Tunnel is running. Public URL: ${status.url} (mode: ${status.mode})`;
        } else if (status.status === 'starting') {
          content = 'Tunnel is starting up. Check back in a few seconds for the URL.';
        } else if (status.status === 'error') {
          content = `Tunnel error: ${status.error ?? 'unknown'}`;
        } else {
          content = 'Tunnel is not running.';
        }
      } else if (action === 'stop') {
        stopTunnel();
        content = 'Tunnel stopped.';
      } else {
        const restarting = action === 'restart';
        if (restarting) {
          stopTunnel();
          await new Promise(r => setTimeout(r, 1500));
        }
        const mode = restarting ? undefined : (args.mode as 'quick' | 'named' | undefined);
        const result = startTunnel(mode);
        if (!result.ok) {
          content = `Error ${restarting ? 'restarting' : 'starting'} tunnel: ${result.error ?? 'unknown'}`;
          isError = true;
          return { content, isError };
        }
        let url: string | null = null;
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 1000));
          const s = getTunnelStatus();
          if (s.status === 'active' && s.url) { url = s.url; break; }
          if (s.status === 'error') { content = `Tunnel failed to ${restarting ? 'restart' : 'start'}: ${s.error ?? 'unknown'}`; isError = true; break; }
        }
        if (!isError) {
          content = url
            ? `Tunnel ${restarting ? 'restarted. New public' : 'started. Public'} URL: ${url}`
            : `Tunnel is ${restarting ? 'restarting' : 'starting'}. Check tunnel({action:"status"}) in a moment for the URL.`;
        }
      }
    } catch (err) {
      content = `Error on tunnel ${action}: ${err instanceof Error ? err.message : String(err)}`;
      isError = true;
    }
    return { content, isError };
  },

  async "set_user_presence"({ args }) {
    let content = '';
    let isError = false;
    try {
      const status = args.status as string;
      if (status !== 'in_dojo' && status !== 'away') {
        content = 'Error: status must be "in_dojo" or "away"';
        isError = true;
        return { content, isError };
      }
      const previous = getPresence();
      setPresence(status);
      content = status === 'away'
        ? `Done. User marked as away. (Was: ${previous})`
        : `Done. User marked as in the dojo. (Was: ${previous})`;
    } catch (err) {
      content = `Error setting presence: ${err instanceof Error ? err.message : String(err)}`;
      isError = true;
    }
    return { content, isError };
  },

  async "reset_session"({ agentId, args }) {
    try {
      // Accept both 'agent_id' and 'agent' (models use inconsistent param names)
      const rawTarget = (args.agent_id as string) ?? (args.agent as string) ?? null;
      if (!rawTarget) {
        return { content: 'Error: agent_id is required. To reset your OWN session, pass your own agent ID explicitly. To reset a sub-agent, pass their agent ID or name.', isError: true };
      }
      const resolved = resolveAgentRef(rawTarget, 'reset_session');
      if (!resolved.ok) return { content: resolved.error, isError: true };
      const result = await resetSession(resolved.id, {
        callerAgentId: agentId,
        reason: typeof args.reason === 'string' ? args.reason : null,
        ownerRequested: args.owner_requested === true,
      });
      if (!result.ok) return { content: result.error, isError: true };
      const targetLabel = resolved.id === agentId ? 'your' : `${result.name}'s`;
      return {
        content: `Session reset complete for ${targetLabel} session. Previous conversation archived to vault.${result.healed ? ' Agent status restored to idle.' : ''}`,
        isError: false,
      };
    } catch (err) {
      return { content: `Error resetting session: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
};
