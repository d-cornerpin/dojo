// Gmail's documented limits that more than one module states. A leaf (no imports), because the tool
// definitions read these at module scope and `gmail-label.ts` sits in an import cycle with them.

/** Gmail's documented maximum ids per `messages.batchModify` call. */
export const BATCH_MODIFY_IDS = 1000;
