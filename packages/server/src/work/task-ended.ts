// Leaf: `ask-settlement.ts` imports `store.ts`, so store must not import it; the settler registers here.
type TaskEnded = (agentId: string, askMessageId: string | null, threadId: string | null, byOwner: boolean) => void;
let hook: TaskEnded | null = null;
export function onTaskEnded(fn: TaskEnded): void { hook = fn; }
export function notifyTaskEnded(agentId: string, askMessageId: string | null, threadId: string | null = null, byOwner = false): void { hook?.(agentId, askMessageId, threadId, byOwner); }
