import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { WsEvent, InterAgentMessage } from '@dojo/shared';
import * as api from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { useActiveAgent } from '../components/ActiveAgentProvider';
import { formatDate } from '../lib/dates';

// ════════════════════════════════════════
// Inter-Agent lane (D-A step 5)
//
// The DEDICATED surface for agent-to-agent (A2A) traffic and engine-origin
// notices. Those rows physically live in `inter_agent_messages` (never the
// primary's `messages` chat table), so this is a STRUCTURALLY separate entity
// from the human chat, not a filtered overlay on it. History loads from
// GET /api/interagent/:agentId; the live path is the `interagent:message` WS
// event. Scope is the currently-viewed agent (the RECIPIENT), mirroring the
// chat's per-agent model (each agent's store holds the messages IT received).
// ════════════════════════════════════════

// Drop a leading [A2A: …] / [SOURCE: …] envelope line: the sender and intent
// render as chips, so the raw marker is noise in the lane. Falls back to the
// full content when the strip would empty it.
function cleanContent(content: string): string {
  const stripped = content.replace(/^\[(?:A2A:|SOURCE:)[^\]]*\]\s*/i, '').trim();
  return stripped.length > 0 ? stripped : content.trim();
}

const ENGINE_GROUP_KEY = '__engine__';

interface ThreadGroup {
  key: string;
  isEngine: boolean;
  label: string;
  messages: InterAgentMessage[];
  lastAt: string;
}

// Intent chip. Peer A2A intents (QUESTION/ASSIGN/ANSWER/…) and engine intents
// (agent_notice/tracker/scheduler/…) both render as a compact pill, copying the
// badge style used on the chat bubbles.
const IntentChip = ({ intent, engine }: { intent: string | null; engine: boolean }) => {
  if (!intent) return null;
  const label = intent.replace(/[_-]+/g, ' ').toUpperCase();
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-mono ${
        engine ? 'bg-cp-teal/10 text-cp-teal' : 'bg-ui/[0.06] text-tertiary'
      }`}
    >
      {label}
    </span>
  );
};

const MessageRow = ({ msg, recipientFallback }: { msg: InterAgentMessage; recipientFallback: string }) => {
  const engine = msg.originKind === 'engine';
  const sender = msg.senderName ?? msg.sourceAgentId ?? (engine ? 'Engine' : 'an agent');
  const recipient = msg.recipientName ?? recipientFallback;
  const body = cleanContent(msg.content);
  return (
    <div className="py-2 border-t border-ui/[0.06] first:border-t-0">
      <div className="flex flex-wrap items-center gap-1.5 mb-1">
        <span className="text-xs font-medium text-ui/90">{sender}</span>
        <span className="text-tertiary text-[11px]">to {recipient}</span>
        <IntentChip intent={msg.intent} engine={engine} />
        {msg.requiresResponse && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-mono bg-ui/[0.06] text-tertiary">
            REPLY NEEDED
          </span>
        )}
        <span className="text-tertiary text-[10px] ml-auto">{formatDate(msg.createdAt)}</span>
      </div>
      {body && (
        <pre className="whitespace-pre-wrap font-sans text-xs sm:text-sm leading-relaxed break-words text-ui/80">
          {body}
        </pre>
      )}
    </div>
  );
};

export function InterAgentLane() {
  const { agentId, agentName } = useActiveAgent();
  const { subscribe } = useWebSocket();
  const [messages, setMessages] = useState<InterAgentMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const agentIdRef = useRef(agentId);
  agentIdRef.current = agentId;

  // Load history whenever the viewed agent changes.
  useEffect(() => {
    let active = true;
    setLoading(true);
    setMessages([]);
    (async () => {
      const result = await api.getInterAgentMessages(agentId, 200);
      if (!active) return;
      if (result.ok) setMessages(result.data);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [agentId]);

  // Live path: append inbound inter-agent messages for the viewed agent.
  useEffect(() => {
    const unsub = subscribe('interagent:message', (event: WsEvent) => {
      if (event.type !== 'interagent:message') return;
      if (event.agentId !== agentIdRef.current) return;
      const incoming = event.message;
      setMessages((prev) => {
        if (prev.some((m) => m.id === incoming.id)) return prev;
        return [...prev, incoming];
      });
    });
    return unsub;
  }, [subscribe]);

  // Group by thread; engine notices (no thread) collect into one bucket. Threads
  // are ordered by most-recent activity; messages within a thread stay
  // chronological.
  const groups = useMemo<ThreadGroup[]>(() => {
    const byKey = new Map<string, ThreadGroup>();
    for (const m of messages) {
      // Group by thread when the row carries one (engine-origin A2A requests do);
      // threadless rows (agent notices, threadless FYIs) collect in one bucket.
      const key = m.threadId ?? ENGINE_GROUP_KEY;
      let group = byKey.get(key);
      if (!group) {
        group = {
          key,
          isEngine: key === ENGINE_GROUP_KEY,
          label: '',
          messages: [],
          lastAt: m.createdAt,
        };
        byKey.set(key, group);
      }
      group.messages.push(m);
      if (m.createdAt > group.lastAt) group.lastAt = m.createdAt;
    }
    // Label each thread from its participants (senders seen on it) + short id.
    for (const group of byKey.values()) {
      if (group.isEngine) {
        group.label = 'Notices';
        continue;
      }
      const senders = Array.from(
        new Set(group.messages.map((m) => m.senderName ?? m.sourceAgentId).filter((s): s is string => !!s)),
      );
      const short = group.key.slice(0, 8);
      group.label = senders.length > 0 ? `${senders.join(', ')} · ${short}` : `Thread ${short}`;
    }
    return Array.from(byKey.values()).sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
  }, [messages]);

  return (
    <>
      <header className="phead">
        <h2 className="phead__title">Agent Threads</h2>
        <span className="phead__meta">Inter-agent</span>
      </header>

      {loading ? (
        <p className="text-tertiary" style={{ fontSize: 12 }}>Loading…</p>
      ) : groups.length === 0 ? (
        <p className="text-tertiary" style={{ fontSize: 12 }}>
          No inter-agent messages yet. Agent-to-agent coordination and engine notices for {agentName || 'this agent'} show up here.
        </p>
      ) : (
        <div className="space-y-3">
          {groups.map((group, i) => (
            <div
              key={group.key}
              className="tile anim"
              style={{ '--ci': `${40 + i * 30}ms` } as React.CSSProperties}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-medium text-ui/90">{group.label}</span>
                <span className="text-tertiary text-[10px] ml-auto">
                  {group.messages.length} message{group.messages.length === 1 ? '' : 's'}
                </span>
              </div>
              {group.messages.map((m) => (
                <MessageRow key={m.id} msg={m} recipientFallback={agentName} />
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
