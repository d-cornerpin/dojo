// Leaf: `ask-settlement.ts` and `done/decide.ts` import `store.ts`, so store must not import them; they register here.
type TaskEnded = (agentId: string, askMessageId: string | null, threadId: string | null) => void;
type PieceEnded = (pieceId: string, byOwner: boolean) => void;
let hook: TaskEnded | null = null;
let pieceHook: PieceEnded | null = null;
export function onTaskEnded(fn: TaskEnded): void { hook = fn; }
export function notifyTaskEnded(agentId: string, askMessageId: string | null, threadId: string | null = null): void { hook?.(agentId, askMessageId, threadId); }
export function onPieceEnded(fn: PieceEnded): void { pieceHook = fn; }
let helperHook: PieceEnded | null = null;
export function onHelperEnded(fn: PieceEnded): void { helperHook = fn; }
export function notifyHelperEnded(agentId: string, byOwner: boolean): void { helperHook?.(agentId, byOwner); }
export function notifyPieceEnded(pieceId: string, byOwner: boolean): void { pieceHook?.(pieceId, byOwner); }
