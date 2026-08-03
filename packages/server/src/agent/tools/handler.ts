// ════════════════════════════════════════════════════════════════════════════
// THE HANDLER CONTRACT (PHASE-5 T4)
//
// T1 built the registry and deliberately left `handler` off it: at that HEAD
// every handler WAS a case inside the 267-case switch in `executeTool`, so a
// `handler` field would have been a placeholder wearing this task's name. This
// module is the field's real content — the shape a relocated handler body has
// once it lives in `agent/tools/cat/*.ts` instead of in that switch.
//
// ── WHY THIS SHAPE AND NOT SOME OTHER ──
// It is the shape the switch already had, written down. Every one of the case
// bodies assigns `content` / `isError` (and sometimes `errorCode`) into the
// locals of `executeToolInner` and `break`s; NOT ONE of them returns a
// `ToolResult` out of the switch. That is a measured fact, not a design choice
// made here, and it is what makes the relocation faithful: a moved body's last
// statement becomes `return { content, isError }` where it used to be
// `content = …; break;`, and everything the executor does AFTER the switch —
// the per-tool `maxResultTokens` cap, the unknown-args warning, the try/catch
// that turns a throw into `Tool execution failed: …`, the audit row — still
// happens in exactly the same place to exactly the same value.
//
// ── WHAT A HANDLER DELIBERATELY DOES NOT GET ──
// No `ToolResult`, no `toolCallId` plumbing, no ability to skip the tail. A
// handler that could return early could skip the result cap, and the cap is a
// context-budget guarantee the loop depends on. The three pre-switch
// interceptors (PDF / Slides / Forms) DO return early and deliberately bypass
// the tail; they are not handlers and are not modelled here.
// ════════════════════════════════════════════════════════════════════════════

import type { ToolErrorCode } from '@dojo/shared';

/**
 * What a handler is told. This is precisely the set of `executeToolInner`
 * locals the case bodies read — no more, so the dependency surface of a moved
 * body is visible in its signature rather than hidden in a closure.
 *
 * `name` is ALIAS-CANONICAL: `executeToolInCallContext` resolves aliases before
 * anything downstream sees the call, so a handler never has to know that
 * `memory_search` was the name on the wire.
 */
export interface ToolHandlerContext {
  /** The calling agent. */
  agentId: string;
  /** The canonical tool name (post-alias). Handlers shared by several tools branch on it. */
  name: string;
  /** The call's arguments, already repaired for aliases and validated at the boundary. */
  args: Record<string, unknown>;
  /** The provider's id for this tool call. */
  callId: string;
}

/**
 * What a handler answers. `content` and `isError` are the two locals the switch
 * assigned; `errorCode` is the structural refusal channel PHASE-4 T1 added so a
 * guard that worked is not classified as a crash from its prose.
 */
export interface ToolHandlerOutcome {
  content: string;
  isError: boolean;
  errorCode?: ToolErrorCode;
}

/** A relocated dispatch case. */
export type ToolHandler = (ctx: ToolHandlerContext) => Promise<ToolHandlerOutcome>;

/**
 * A category module's export: its handlers keyed by DISPATCH KEY.
 *
 * The key is the dispatch key, not the tool name, and the distinction is load
 * bearing for the work verbs: PHASE-2 T8V made the switch key on
 * `workOperation(name, args) ?? name`, so `work_update` reaches five different
 * bodies under `work_update:status`, `work_update:edit`, … A map keyed on tool
 * name could not express that, and flattening it would be exactly the
 * "improvement during a move" this task's relocation purity forbids.
 */
export type ToolHandlerMap = Readonly<Record<string, ToolHandler>>;
