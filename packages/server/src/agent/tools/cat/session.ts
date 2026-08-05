// ════════════════════════════════════════════════════════════════════════════
// TUNNEL, PRESENCE AND SESSION RESET (PHASE-5 T4 — relocated from
// `agent/tools.ts`)
//
// Three single-key categories that share one property: each acts on the DOJO's
// own state rather than on a document, a person or another agent, and none of
// them fits the platform-controls module without pushing it past its ceiling.
//
// ── `reset_session` IS DELIBERATELY NOT A DOJO-CONTROL ──
// `PRIMARY_ONLY_TOOLS` does not contain it, and the reason is written at that
// constant: the Healer — a NON-primary service agent — legitimately calls the
// reset_session TOOL to clear a wedged agent's corrupted context. It stays
// surface-stripped but stays executable. That distinction is a gate's, not a
// handler's, and the gate is not in this file.
//
// RELOCATION, NOT REWRITE. `tunnel`'s install-cloudflared branch, the presence
// re-route and reset_session's divider + system-prompt rewrite are byte-faithful.
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
import { onAgentRecovered } from '../../../healer/injury-recovery.js';
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
    // C27: mutating actions stay primary-only (pre-merge, only tunnel_status
    // was available to non-primary agents); status is open to all.
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
        // start or restart share the poll-for-URL tail; restart stops first.
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
      // STRIP (PHASE-0 T12): dropped an `agent:status` broadcast carrying `presence:<status>` — not an agent status, zero subscribers (PresenceProvider reads GET /system/presence); it only left Agents/Tracker holding it as the agent's status. requirement preserved: setPresence persists config('user_presence'), the fact every reader consults.
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

      // Safety: if no target specified, the agent is resetting itself.
      // Require explicit confirmation to prevent accidental self-resets.
      if (!rawTarget) {
        content = 'Error: agent_id is required. To reset your OWN session, pass your own agent ID explicitly. To reset a sub-agent, pass their agent ID or name.';
        isError = true;
        return { content, isError };
      }

      // Resolve agent reference (UUID, sensei id, or name, case-insensitive)
      const resolveResult = resolveAgentRef(rawTarget, 'reset_session');
      if (!resolveResult.ok) { content = resolveResult.error; isError = true; return { content, isError }; }
      const resolvedId = resolveResult.id;
      const agent = db.prepare('SELECT id, name, status FROM agents WHERE id = ?').get(resolvedId) as { id: string; name: string; status: string };

      // Idempotency: if the target is already terminated, refuse cleanly
      // instead of archiving an empty conversation and confusing the
      // caller. Resetting a terminated agent is almost always a mistake
      //, they have no live state to reset.
      if (agent.status === 'terminated') {
        content = `Agent "${agent.name}" is already terminated, there is no live session to reset. Spawn a new agent if you need a fresh start.`;
        isError = true;
        return { content, isError };
      }

      // Mid-turn guard: never reset ANOTHER agent while it is genuinely in a
      // live turn. A real in-process run is tracked in activeRuns; a STALE DB
      // status='working' row (a wedged agent whose run is actually gone) is
      // NOT in activeRuns, and healing exactly that wedged case is the whole
      // point of this tool, so we gate on activeRuns, never on the DB status.
      // Without this a genuinely-running target got reset underneath its own
      // turn and its work leaked past the New Session divider. Self-reset is
      // exempt: an agent resetting its OWN session mid-turn is intentional
      // (the boundary + reorient take hold as its current turn winds down).
      if (resolvedId !== agentId && activeRuns.has(resolvedId)) {
        content = `Agent "${agent.name}" is in the middle of a live turn right now. Resetting it would cut its work off mid-thought and leak that work past the new-session divider. Wait for it to go idle, then reset.`;
        isError = true;
        return { content, isError };
      }

      // Archive current conversation to vault. force=true so we always create
      // a new archive, without it, an existing unprocessed archive blocks the
      // re-archive and the post-reset conversation is silently lost.
      const archiveId = archiveAgentConversation(resolvedId, true);

      // NOTE: we intentionally do NOT clear context items (summaries).
      // Summaries from before the reset are still valid compressed history
      // of what the agent was working on. Clearing them causes amnesia, 
      // the agent loses all project context with nothing to replace it
      // until compaction runs again (which could be hours).
      // The session_started_at boundary already prevents old raw messages
      // from appearing in the fresh tail, summaries are the ONLY way
      // the agent retains context across a reset.

      // Set session boundary and clear stale continuity brief + session
      // scratchpad. Scratchpad is session-scoped (its own tool docs promise
      // it "auto-clears on session reset"); leaving it behind bleeds the
      // prior task's outline into the fresh session via the assembler.
      const now = new Date();
      const boundary = now.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
      db.prepare("UPDATE agents SET session_started_at = ?, updated_at = ?, config = json_remove(COALESCE(config, '{}'), '$.continuityBrief', '$.scratchpad') WHERE id = ?").run(boundary, boundary, resolvedId);

      // Carry a fired-but-undelivered reminder/scheduler event across the
      // reset boundary so it is not silently lost (all engine-event queries
      // gate created_at >= session_started_at). Narrow scope: unclaimed
      // deliverable engine rows only, never ordinary conversation.
      rehomeUnclaimedEngineEvents(resolvedId, boundary);

      // Insert UI divider. The row's created_at is stamped by the writer at insert
      // time, which is at-or-after `boundary` (computed a few lines up), so the
      // divider still lands inside the new session for every `created_at >=
      // session_started_at` query. The broadcast keeps quoting `boundary` for the UI.
      const markerId = uuidv4();
      insertMessageIfAbsent({ id: markerId, agentId: resolvedId, role: 'system', content: NEW_SESSION_DIVIDER });
      broadcast({ type: 'chat:message', agentId: resolvedId, message: { id: markerId, agentId: resolvedId, role: 'system', content: NEW_SESSION_DIVIDER, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: boundary } });

      // Inject the reorientation prompt. Picks between full reorient
      // (agent has active tasks → pick up where you left off) and
      // fresh-start (no active tasks → don't dredge up old work).
      const reorientId = uuidv4();
      const reorientContent = buildSessionResetMessage(resolvedId);
      insertMessageIfAbsent({ id: reorientId, agentId: resolvedId, role: 'system', content: reorientContent });
      broadcast({ type: 'chat:message', agentId: resolvedId, message: { id: reorientId, agentId: resolvedId, role: 'system', content: reorientContent, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: boundary } });

      // If the agent is in error/paused status, heal it by setting to idle.
      // A session reset clears corrupted context, which is often the root
      // cause of the error. Without this, reset_session clears the context
      // but leaves the agent stuck in error status.
      if (agent.status === 'error' || agent.status === 'paused') {
        writeAgentStatus(resolvedId, 'idle', { clearError: true });
        broadcast({ type: 'agent:status', agentId: resolvedId, status: 'idle' });
        // Notify injury recovery that the agent is healed
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
