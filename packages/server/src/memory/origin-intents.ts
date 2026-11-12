// The named `origin_intent` values a writer and its readers share. This file imports nothing and must keep it:
// `work/ask-settlement.ts` reads START_ACK_ORIGIN_INTENT at module scope inside an import cycle with message-store.

/** Marks a row as the agent bus (spawn results, PM status, scheduler notices), not peer conversation. */
export const AGENT_BUS_INTENT = 'agent_bus';

/** Marks the promoted start line; `work/ask-settlement.ts` refuses it as an ask's receipt. */
export const START_ACK_ORIGIN_INTENT = 'engine_start_ack';
