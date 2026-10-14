// A leaf (imports nothing): who to tell when a tracker task ends (t152). The writer of work state
// (`store.ts`) and the ask settlement authority (`ask-settlement.ts`) import each other's graph, so the
// authority registers here instead and the writer calls through, and neither takes an import of the other.
type TaskEnded = (agentId: string, askMessageId: string | null) => void;
let hook: TaskEnded | null = null;
export function onTaskEnded(fn: TaskEnded): void { hook = fn; }
export function notifyTaskEnded(agentId: string, askMessageId: string | null): void { hook?.(agentId, askMessageId); }
