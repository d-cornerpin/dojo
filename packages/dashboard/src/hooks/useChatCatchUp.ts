import { useEffect, useRef } from 'react';
import type { Message } from '@dojo/shared';
import * as api from '../lib/api';

/** One mapping from a stored message to what the chat draws (the load, the older pages and the
 *  reconnect catch-up all use it). */
export const toMessage = (m: Message) => ({
  id: m.id,
  role: m.role,
  content: m.content,
  createdAt: m.createdAt,
  modelId: m.modelId,
  attachments: m.attachments,
  source: m.source ?? null,
  origin: m.origin,
  inboundMeta: m.inboundMeta ?? null,
  conversationId: m.conversationId,
  displayKind: m.displayKind ?? null,
});

interface CatchUp<T extends { id: string; createdAt: string; isStreaming?: boolean }> {
  /** The shared reconnect signal from `useWebSocket()`. */
  reconnectCount: number;
  agentId: string;
  /** Always the current agent (a ref), so an answer for an agent that was left is ignored. */
  agentIdRef: { current: string };
  wordyMode: boolean;
  /** False while a technique session has not decided what to show. */
  ready: boolean;
  /** Frames heard for this agent: a status frame newer than the question stands. */
  statusFrameSeqRef: { current: number };
  setMessages: (update: (prev: T[]) => T[]) => void;
  setIsWorking: (v: boolean) => void;
  setBackgroundStoppable: (v: boolean) => void;
  toChat: (m: Message) => T;
}

/**
 * Catch up after a reconnect. Frames sent while the socket was down never arrive: a finished
 * reply is missing, or the working state is stale (the closing status frame was lost). On a
 * change of the shared reconnect signal (never at mount) ask again, quietly: take the agent's
 * status, and MERGE the newest page into what is on screen. Scroll, pin, `hasMore` and the
 * loading state are not touched. A late answer never overwrites a newer one.
 */
export function useChatCatchUp<T extends { id: string; createdAt: string; isStreaming?: boolean }>(o: CatchUp<T>): void {
  const seenRef = useRef(o.reconnectCount);
  const latestRef = useRef(0);
  useEffect(() => {
    if (seenRef.current === o.reconnectCount) return;
    seenRef.current = o.reconnectCount;
    if (!o.ready) return;
    const mine = ++latestRef.current;
    const forAgent = o.agentId;
    const stale = () => mine !== latestRef.current || forAgent !== o.agentIdRef.current;
    void (async () => {
      const seq = o.statusFrameSeqRef.current;
      let turnEnded = false; // the caught-up state says no live turn exists for this agent
      const agentResult = await api.getAgent(forAgent);
      if (stale()) return;
      if (agentResult.ok && o.statusFrameSeqRef.current === seq) {
        turnEnded = agentResult.data.status !== 'working';
        o.setIsWorking(!turnEnded);
        const f = agentResult.data.inFlight;
        o.setBackgroundStoppable(!!f && f.background > 0);
      }
      const result = await api.getChatHistory(forAgent, 200, undefined, o.wordyMode);
      if (stale() || !result.ok) return;
      const fetched = result.data.map(o.toChat);
      o.setMessages((prev) => {
        const out = [...prev];
        let changed = false;
        for (const m of fetched) {
          const at = out.findIndex((x) => x.id === m.id);
          if (at < 0) { out.push(m); changed = true; }
          else if (out[at].isStreaming) { out[at] = m; changed = true; } // the final message arrived
        }
        // A streaming bubble whose turn is over (and whose final message was not in the page)
        // can never finish: it goes. The caught-up answer is the signal, not a timer.
        const kept = turnEnded ? out.filter((x) => !x.isStreaming || fetched.some((f) => f.id === x.id)) : out;
        if (kept.length !== out.length) changed = true;
        return changed ? kept.sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : prev;
      });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.reconnectCount]);
}
