
import type { ToolCall, ToolErrorCode } from '@dojo/shared';

export interface ToolHandlerContext {
  agentId: string;
  /** `name` is post-alias, `args` repaired and validated; `toolCall` only feeds the vision side channel. */
  name: string;
  args: Record<string, unknown>;
  callId: string;
  toolCall: ToolCall;
}

/** What a handler returns: a value, never a ToolResult or early return, so the result cap and audit run. */
export interface ToolHandlerOutcome {
  content: string;
  isError: boolean;
  errorCode?: ToolErrorCode;
}

export type ToolHandler = (ctx: ToolHandlerContext) => Promise<ToolHandlerOutcome>;

export type ToolHandlerMap = Readonly<Record<string, ToolHandler>>;
