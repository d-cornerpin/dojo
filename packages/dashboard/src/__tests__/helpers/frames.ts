// ════════════════════════════════════════════════════════════════════════════
// THE FAKE FRAME BUS — what replaces `hooks/useWebSocket` in a component test.
//
// Three reports (T5 §2b, T6 §7, T7 §6) each wrote the same rule down as prose
// because nothing could drive it: *"the subscribe() wirings and their cleanup —
// React lifecycle; requires a DOM runner"*. The wiring is only observable if a
// test can PUSH a frame and then look at what the component did, so this is the
// smallest thing that can do that: a registry keyed by event type, a matching
// `subscribe` that returns its own unsubscribe, and a count of live handlers so
// a test can assert CLEANUP as well as arrival.
//
// It is deliberately not a WebSocket. A fake socket would test happy-dom's
// socket, and the rule is about the component's subscriptions.
// ════════════════════════════════════════════════════════════════════════════

type Handler = (event: unknown) => void;

const handlers = new Map<string, Set<Handler>>();

/** Stand-in for `useWebSocket()`. Same shape, no network. */
export const fakeUseWebSocket = () => ({
  subscribe: (eventType: string, callback: Handler) => {
    let set = handlers.get(eventType);
    if (!set) { set = new Set(); handlers.set(eventType, set); }
    set.add(callback);
    return () => { set?.delete(callback); };
  },
  isConnected: () => true,
  connectionStatus: 'connected' as const,
});

/** Deliver one frame to every live subscriber of that type. */
export function emitFrame(eventType: string, payload: Record<string, unknown> = {}): void {
  for (const h of handlers.get(eventType) ?? []) h({ type: eventType, ...payload });
}

/** How many live handlers a type has — this is how unmount cleanup is asserted. */
export function handlerCount(eventType: string): number {
  return handlers.get(eventType)?.size ?? 0;
}

export function resetFrames(): void {
  handlers.clear();
}

/** Stand-in for `useToast()`: every method recorded, nothing rendered. */
export function fakeToast() {
  const calls: Array<{ level: string; message: string }> = [];
  const record = (level: string) => (message: string) => { calls.push({ level, message }); };
  return {
    calls,
    value: {
      toasts: [],
      addToast: () => {},
      addActionToast: () => {},
      removeToast: () => {},
      removeToastByKey: () => {},
      info: record('info'),
      success: record('success'),
      warning: record('warning'),
      error: record('error'),
    },
  };
}
