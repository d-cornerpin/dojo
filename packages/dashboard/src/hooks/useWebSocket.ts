import { createContext, useContext, useEffect, useRef, useCallback, useState, type ReactNode } from 'react';
import React from 'react';
import type { WsEvent } from '@dojo/shared';
import { getToken } from '../lib/api';

// ════════════════════════════════════════
// WebSocket Hook — bulletproof version
// Heartbeat, auto-reconnect with backoff,
// connection status, StrictMode safe
// ════════════════════════════════════════

type EventCallback = (event: WsEvent) => void;
export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';

interface WebSocketContextValue {
  subscribe: (eventType: string, callback: EventCallback) => () => void;
  isConnected: () => boolean;
  connectionStatus: ConnectionStatus;
}

const WebSocketContext = createContext<WebSocketContextValue | null>(null);

// ── Constants ──

const HEARTBEAT_TIMEOUT_MS = 45_000;    // If no ping received in 45s, assume dead
const INITIAL_RECONNECT_MS = 1_000;     // Start reconnect at 1s
const MAX_RECONNECT_MS = 30_000;        // Cap at 30s
const BACKOFF_MULTIPLIER = 2;

export const WebSocketProvider = ({ children }: { children: ReactNode }) => {
  const wsRef = useRef<WebSocket | null>(null);
  const subscribersRef = useRef<Map<string, Set<EventCallback>>>(new Map());
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismountedRef = useRef(false);
  const reconnectDelayRef = useRef(INITIAL_RECONNECT_MS);
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');

  // ── Heartbeat ──

  const resetHeartbeatTimer = useCallback(() => {
    if (heartbeatTimeoutRef.current) {
      clearTimeout(heartbeatTimeoutRef.current);
    }
    heartbeatTimeoutRef.current = setTimeout(() => {
      // No ping received — connection is dead
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.close(4000, 'Heartbeat timeout');
      }
    }, HEARTBEAT_TIMEOUT_MS);
  }, []);

  // ── Connect ──

  const connect = useCallback(() => {
    if (dismountedRef.current) return;

    const token = getToken();
    if (!token) {
      // No token yet — retry in 2s (might be during OOBE)
      reconnectTimeoutRef.current = setTimeout(connect, 2000);
      return;
    }

    // Clean up existing connection
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (wsRef.current) {
      const oldWs = wsRef.current;
      oldWs.onmessage = null;
      oldWs.onclose = null;
      oldWs.onerror = null;
      if (oldWs.readyState === WebSocket.OPEN) {
        oldWs.close();
      } else if (oldWs.readyState === WebSocket.CONNECTING) {
        // StrictMode safety: don't close a CONNECTING socket directly
        oldWs.onopen = () => { try { oldWs.close(); } catch { /* ignore */ } };
      }
      wsRef.current = null;
    }

    setStatus('connecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/api/ws?token=${encodeURIComponent(token)}`;

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (dismountedRef.current) { ws.close(); return; }
        setStatus('connected');
        reconnectDelayRef.current = INITIAL_RECONNECT_MS; // Reset backoff on success
        resetHeartbeatTimer();
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          // Handle server pings — respond with pong
          if (data.type === 'ping') {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'pong' }));
            }
            resetHeartbeatTimer();
            return;
          }

          // Dispatch to subscribers
          const wsEvent = data as WsEvent;
          const callbacks = subscribersRef.current.get(wsEvent.type);
          if (callbacks) {
            callbacks.forEach((cb) => cb(wsEvent));
          }
          const wildcardCallbacks = subscribersRef.current.get('*');
          if (wildcardCallbacks) {
            wildcardCallbacks.forEach((cb) => cb(wsEvent));
          }
        } catch {
          // Ignore non-JSON messages
        }
      };

      ws.onclose = (event) => {
        wsRef.current = null;
        if (heartbeatTimeoutRef.current) {
          clearTimeout(heartbeatTimeoutRef.current);
          heartbeatTimeoutRef.current = null;
        }

        // If server rejected due to invalid/expired token, redirect to login
        // instead of endlessly reconnecting with the same bad token
        if (event.code === 1008) {
          setStatus('disconnected');
          localStorage.removeItem('dojo_token');
          window.location.href = '/login';
          return;
        }

        if (!dismountedRef.current) {
          setStatus('disconnected');
          // Reconnect with exponential backoff
          const delay = reconnectDelayRef.current;
          reconnectDelayRef.current = Math.min(delay * BACKOFF_MULTIPLIER, MAX_RECONNECT_MS);
          reconnectTimeoutRef.current = setTimeout(connect, delay);
        }
      };

      ws.onerror = () => {
        // onerror is always followed by onclose — let onclose handle reconnection
        // Don't call ws.close() here, it will trigger onclose
      };
    } catch {
      setStatus('disconnected');
      if (!dismountedRef.current) {
        const delay = reconnectDelayRef.current;
        reconnectDelayRef.current = Math.min(delay * BACKOFF_MULTIPLIER, MAX_RECONNECT_MS);
        reconnectTimeoutRef.current = setTimeout(connect, delay);
      }
    }
  }, [resetHeartbeatTimer]);

  // ── Subscribe ──

  const subscribe = useCallback(
    (eventType: string, callback: EventCallback): (() => void) => {
      if (!subscribersRef.current.has(eventType)) {
        subscribersRef.current.set(eventType, new Set());
      }
      subscribersRef.current.get(eventType)!.add(callback);

      return () => {
        const set = subscribersRef.current.get(eventType);
        if (set) {
          set.delete(callback);
          if (set.size === 0) {
            subscribersRef.current.delete(eventType);
          }
        }
      };
    },
    [],
  );

  const isConnected = useCallback(() => {
    return wsRef.current?.readyState === WebSocket.OPEN;
  }, []);

  // ── Lifecycle ──

  useEffect(() => {
    dismountedRef.current = false;
    connect();

    return () => {
      dismountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (heartbeatTimeoutRef.current) {
        clearTimeout(heartbeatTimeoutRef.current);
        heartbeatTimeoutRef.current = null;
      }
      if (wsRef.current) {
        const oldWs = wsRef.current;
        oldWs.onmessage = null;
        oldWs.onclose = null;
        oldWs.onerror = null;
        if (oldWs.readyState === WebSocket.OPEN) {
          oldWs.close();
        } else if (oldWs.readyState === WebSocket.CONNECTING) {
          oldWs.onopen = () => { try { oldWs.close(); } catch { /* ignore */ } };
        }
        wsRef.current = null;
      }
    };
  }, [connect]);

  return React.createElement(
    WebSocketContext.Provider,
    { value: { subscribe, isConnected, connectionStatus: status } },
    children,
  );
};

export const useWebSocket = (): WebSocketContextValue => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};
