// ════════════════════════════════════════
// Tool-eligibility config generation (FA-TS1)
//
// A module-level monotonic counter bumped from every write that can change the
// GLOBAL tool-eligibility surface computed by getFilteredTools:
//   - google_accounts / microsoft_accounts writes (connect / disconnect, enable
//     / disable, per-service toggles)
//   - Plaud connect / disconnect
//   - Office package install / removal
//   - audio-gen model change (tts_create description enrichment)
//
// getFilteredTools memoizes its result per (agentId, generation, agent
// fingerprint). Bumping this counter invalidates every agent's cached tool list
// on the next call, so a service toggle or account connect changes the advertised
// surface by the next turn.
//
// This lives in its own zero-import module so the low-level account / config
// writers can bump it without importing the module that owns the memo, which
// would close an import cycle. PHASE-5 T4 re-pointed the names, not the rule:
// the memo is now `agent/tools/surface.ts` and the loop it would close is
// surface.ts -> google/auth.ts -> google/accounts.ts -> surface.ts.
// ════════════════════════════════════════

let generation = 0;

/** Invalidate every memoized tool-eligibility list. Call from any write that
 *  changes the global integration / tool surface. */
export function bumpToolConfigGeneration(): void {
  generation++;
}

/** Current generation. Read by getFilteredTools' memo key. */
export function getToolConfigGeneration(): number {
  return generation;
}
