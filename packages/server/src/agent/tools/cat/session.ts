// ════════════════════════════════════════════════════════════════════════════
// TUNNEL, PRESENCE AND SESSION RESET: each acts on the DOJO's own state, not on a
// document, a person or another agent.
// ── `reset_session` IS DELIBERATELY NOT A DOJO-CONTROL ──
// `PRIMARY_ONLY_TOOLS` omits it: the Healer (a NON-primary service agent)
// legitimately calls the reset TOOL on a wedged agent, so it stays executable while
// surface-stripped; that distinction belongs to a gate, not to this file.
// ════════════════════════════════════════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { NEW_SESSION_DIVIDER } from '@dojo/shared';
import { getDb } from '../../../db/connection.js';
import { broadcast } from '../../../gateway/ws.js';
import { writeAgentStatus } from '../../agent-status.js';
import { isPrimaryAgent } from '../../../config/platform.js';
import { insertMessageIfAbsent } from '../../../memory/message-store.js';
import { resolveAgentRef } from '../../tool-helpers.js';
import { toolsLogger as logger } from '../util.js';
import { activeRuns } from '../../shared-state.js';
import { archiveAgentConversation } from '../../../vault/archive.js';
import { buildSessionResetMessage } from '../../session-reset.js';
import { getTunnelStatus, startTunnel, stopTunnel } from '../../../services/tunnel.js';
import { onAgentRecovered, evaluateSessionResetGuard } from '../../../healer/injury-recovery.js';
import { rehomeUnclaimedEngineEvents } from '../../v2/counterparty.js';
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
        ? `Done. User marked as away. Messages will be forwarded via iMessage. (Was: ${previous})`
        : `Done. User marked as in the dojo. Messages will go to the dashboard. (Was: ${previous})`;
    } catch (err) {
      content = `Error setting presence: ${err instanceof Error ? err.message : String(err)}`;
      isError = true;
    }
    return { content, isError };
  },

  async "reset_session"({ agentId, args }) {
    let content = '';
    let isError = false;
    try {
      const db = getDb();
      // Accept both 'agent_id' and 'agent' (models use inconsistent param names)
      const rawTarget = (args.agent_id as string) ?? (args.agent as string) ?? null;

      if (!rawTarget) {
        content = 'Error: agent_id is required. To reset your OWN session, pass your own agent ID explicitly. To reset a sub-agent, pass their agent ID or name.';
        isError = true;
        return { content, isError };
      }

      const resolveResult = resolveAgentRef(rawTarget, 'reset_session');
      if (!resolveResult.ok) { content = resolveResult.error; isError = true; return { content, isError }; }
      const resolvedId = resolveResult.id;
      const agent = db.prepare('SELECT id, name, status FROM agents WHERE id = ?').get(resolvedId) as { id: string; name: string; status: string };

      if (agent.status === 'terminated') {
        content = `Agent "${agent.name}" is already terminated, there is no live session to reset. Spawn a new agent if you need a fresh start.`;
        isError = true;
        return { content, isError };
      }

      // Never reset ANOTHER agent mid live turn; gate on activeRuns, never on the
      // DB status: a stale 'working' row whose run is gone is exactly the wedged
      // case this tool heals. Self-reset is exempt: mid-turn self-reset is intentional.
      if (resolvedId !== agentId && activeRuns.has(resolvedId)) {
        content = `Agent "${agent.name}" is in the middle of a live turn right now. Resetting it would cut its work off mid-thought and leak that work past the new-session divider. Wait for it to go idle, then reset.`;
        isError = true;
        return { content, isError };
      }

      // The Healer KEEPS session reset, but a size-class injury takes compaction
      // first: refuse unless compact-and-redial failed on 2 distinct turns, corruption
      // is diagnosed (reason="corruption") or owner_requested=true; see `evaluateSessionResetGuard`.
      const resetGuard = evaluateSessionResetGuard(resolvedId, {
        reason: typeof args.reason === 'string' ? args.reason : null,
        ownerRequested: args.owner_requested === true,
      });
      if (!resetGuard.allowed) {
        content = resetGuard.refusalText
          ?? 'Session reset refused: compaction comes first for this injury class.';
        isError = true;
        return { content, isError };
      }

      // force=true: else an unprocessed archive blocks the re-archive and the fresh conversation is lost.
      const archiveId = archiveAgentConversation(resolvedId, true);

      // Summaries are intentionally NOT cleared: they are the agent's only context
      // across a reset, and `session_started_at` already keeps old raw rows out.

      // Also forget session-loaded tool docs and served conversations; both clears
      // live in `agent/session-forget.js`, loaded lazily to keep it off this graph.
      await (await import('../../session-forget.js')).forgetSessionScratch(resolvedId);

      // The scratchpad must clear too: its docs promise it, and it would bleed the old outline forward.
      const now = new Date();
      const boundary = now.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
      db.prepare("UPDATE agents SET session_started_at = ?, updated_at = ?, config = json_remove(COALESCE(config, '{}'), '$.scratchpad') WHERE id = ?").run(boundary, boundary, resolvedId);

      // Unclaimed deliverable engine rows are rehomed across the boundary, never ordinary chat.
      rehomeUnclaimedEngineEvents(resolvedId, boundary);

      // The divider's created_at is stamped at insert time, at or after `boundary`, so it stays inside.
      const markerId = uuidv4();
      insertMessageIfAbsent({ id: markerId, agentId: resolvedId, role: 'system', content: NEW_SESSION_DIVIDER });
      broadcast({ type: 'chat:message', agentId: resolvedId, message: { id: markerId, agentId: resolvedId, role: 'system', content: NEW_SESSION_DIVIDER, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: boundary } });

      const reorientId = uuidv4();
      const reorientContent = buildSessionResetMessage(resolvedId);
      insertMessageIfAbsent({ id: reorientId, agentId: resolvedId, role: 'system', content: reorientContent });
      broadcast({ type: 'chat:message', agentId: resolvedId, message: { id: reorientId, agentId: resolvedId, role: 'system', content: reorientContent, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: boundary } });

      // An error/paused agent heals to idle: the reset cleared the context that caused it.
      if (agent.status === 'error' || agent.status === 'paused') {
        writeAgentStatus(resolvedId, 'idle', { clearError: true });
        broadcast({ type: 'agent:status', agentId: resolvedId, status: 'idle' });
        try {
          onAgentRecovered(resolvedId);
        } catch { /* module may not be available */ }
      }

      const targetLabel = resolvedId === agentId ? 'your' : `${agent?.name ?? resolvedId}'s`;
      content = `Session reset complete for ${targetLabel} session. Previous conversation archived to vault.${agent.status === 'error' || agent.status === 'paused' ? ' Agent status restored to idle.' : ''}`;
      logger.info('Session reset via tool', { callerAgentId: agentId, targetAgentId: resolvedId, archiveId }, agentId);
    } catch (err) {
      content = `Error resetting session: ${err instanceof Error ? err.message : String(err)}`;
      isError = true;
    }
    return { content, isError };
  },
};
