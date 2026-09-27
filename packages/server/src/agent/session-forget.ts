// ════════════════════════════════════════════════════════════════════════════
// WHAT A SESSION RESET FORGETS — ONE ANSWER, FIVE DOORS.
//
// Two backlog lines, one cause (BACKLOG.md, 2026-09-26): "system.ts:218 + agents.ts:607
// possibly missing clearSessionLoadedTools (never audited)" and "the two session-reset doors
// still disagree on clearServedConversations (tool doesn't, route does; pre-existing)".
//
// ── MEASURED BEFORE ANYTHING WAS CHANGED ──────────────────────────────────────────────
// FIVE sites write `agents.session_started_at`, which IS the session boundary. They gave
// FOUR different answers:
//
//   door                                        tool docs   turn-continuity scratch
//   reset_session TOOL (agent/tools/cat/session)    yes               NO
//   chat reset route (gateway/routes/chat)          yes              yes
//   agents reset route (gateway/routes/agents)       NO              yes
//   system bulk-idle sweep (gateway/routes/system)   NO               NO
//   Dreamer cycle (vault/maintenance)               yes               NO
//
// Exactly one door did both. What the misses cost, in the product rather than in theory:
// an agent reset from the agent card, or swept by the idle sweep, KEPT every tool it had
// loaded — so its API tools array never returned to the always-loaded head until the process
// restarted — and never got the rehydration flag, so a later restart re-imported the
// pre-reset history the reset had just decided to forget. In the other direction, three
// doors left the turn-continuity scratch behind: the human-conversation drain spin-guard and
// the cross-turn untracked-work counter kept counting ACROSS a boundary whose whole job is
// to end them.
//
// ── WHICH SIDE WAS RIGHT: THE ROUTE'S — AND NOT AS A PREFERENCE ───────────────────────
// Each cleaner's own contract settles it. `clearServedConversations`: "Reset the per-agent
// turn-continuity scratch state ON A NEW SESSION." `clearSessionLoadedTools`: "A reset is a
// DECISION to forget." Both are defined per-session, so every door that moves the boundary
// owes both. Nothing here widens either cleaner's scope; they are simply called everywhere
// they were already defined to apply.
//
// ── WHY A FUNCTION AND NOT A FIFTH COPY ──────────────────────────────────────────────
// The disagreement IS the defect: four hand-rolled copies drifted into four answers, and a
// sixth door would have drifted again. So the answer lives in one place, and
// `__tests__/every-session-reset-door-forgets-the-same-things.test.ts` walks the source for
// boundary writers and refuses any that does not come through here.
//
// Both clears are DYNAMIC imports and individually best-effort, exactly as every door had
// them: this must never be the reason a reset fails, and the dynamic import keeps
// `tools/tool-docs.js` and `agent/turn-state.js` off the callers' static graphs — the
// property the tool door's own W4 note explicitly protects.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Forget the per-session scratch state that does not survive a session boundary.
 *
 * Called by every writer of `agents.session_started_at`. Best-effort by design, per clear:
 * a reset that cannot drop the tool docs must still drop the continuity scratch, and
 * neither may abort the reset itself.
 */
export async function forgetSessionScratch(agentId: string): Promise<void> {
  try {
    const { clearSessionLoadedTools } = await import('../tools/tool-docs.js');
    clearSessionLoadedTools(agentId);
  } catch { /* best-effort — never the reason a reset fails */ }
  try {
    // ⚠ THE WIDENING HERE IS CALLER COUNT, NOT SCOPE (final sweep C, B7 — 2026-09-26).
    // This clear had TWO doors before the smallfry round and has FIVE now, because every session
    // boundary routes through this one cleaner. Its docstring in `turn-state.ts` records the one
    // prior failure this function already had, and the axis matters: that incident was a WIDER
    // BODY — clearing both drain ladders instead of the human one — which handed the unserved-wake
    // drain two extra passes per session start and was caught by `fanout-serves-all-pieces`
    // tripping the platform's own wake budget. The body is untouched here; what changed is how
    // many doors reach it, and each of those doors is a session RESET, which is the one event the
    // spin-guard is supposed to forget. The risk the incident names — more self-wakes — scales
    // with passes per reset, not with the number of doors that can cause a reset, so five doors
    // clearing once each is the same blast radius as two doors clearing once each. A future edit
    // that widens the BODY re-opens the incident; adding a sixth session door does not.
    const { clearServedConversations } = await import('./turn-state.js');
    clearServedConversations(agentId);
  } catch { /* best-effort — never the reason a reset fails */ }
}
