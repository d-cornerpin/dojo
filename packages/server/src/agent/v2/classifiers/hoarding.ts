// ════════════════════════════════════════
// Anti-hoarding gate (v2.5.43, measured-size rewrite 2026-07-08)
//
// Field test: prompt-level guidance about "open a tracker project before
// loading sources" was being ignored by DeepSeek V4 Pro on
// corpus-synthesis tasks. The primary agent made 9 source-loading calls in 4 turns
// (use_technique, file_read x3, list_agents, exec, get_agent_profile x3)
// without ever calling tracker_create_project, file_write, or
// scratchpad_set. The reflex was in its prompt; it just plowed through.
//
// CLAUDE.md rule: "The engine enforces. The model follows prompts."
// So enforcement lives in the loop, not the prompt.
//
// D3: this is a NON-BLOCKING advisory, not a refusal. When many unscaffolded
// loads have entered context in one turn AND context is genuinely near
// compaction (real confabulation risk), the loop nudges ONCE to write the
// sources down; reads are never blocked (see loop.ts).
//
// ── What "a load" is: MEASURED SIZE, not a curated name-list ──
//
// The old design counted calls to a hand-maintained LOADING_TOOLS set (file_read,
// gmail_read, web_fetch, ...). That set froze a snapshot of the tool surface and
// rotted with every tool added: onenote/plaud reads, calendar_list, gmail_inbox,
// the drive/onedrive versions, and every future reader silently fell out and so
// never counted, weakening the gate exactly where new surface appears. An
// omission there could only ever WEAKEN the gate, and nobody re-audits the list.
//
// The question this gate actually asks is "how much MATERIAL entered working
// memory this turn," and the engine already knows every tool result's size the
// moment it lands. So the counter now ticks on RESULT SIZE, tool-agnostic: any
// successful tool result whose text payload is at least LOADING_RESULT_MIN_TOKENS
// counts as one heavy load, regardless of which tool produced it. A brand-new
// reader (present or future) that returns a real chunk of corpus counts by
// construction; there is no list to keep in sync. This also FIXES a latent
// over-count in the old design: an empty gmail_search ("no results", ~9 tokens)
// used to tick the counter even though it loaded nothing; now it correctly does
// not, because nothing entered context.
//
// Small reads stay free by design: a time lookup, a short agenda, an empty search
// fall below the floor and never nudge; a real file read / email body / web page
// / search-with-hits from ANY tool crosses it. See LOADING_RESULT_MIN_TOKENS for
// the calibration against real production tool results.
//
// Two exemptions survive because they are NOT external-corpus confabulation risk,
// and size alone cannot tell them apart from a big external load:
//   - recall_recent_thread (OPEN-16): a bounded read of the CURRENT conversation's
//     recent turns (conversation-scoped as of OPEN-15), an orientation read the
//     agent uses to answer "what was just happening", not external corpus that
//     confabulates. Counting it pushed routine lookups over the gate.
//   - tracker_* reads (OPEN-2): the tracker is the agent's own STRUCTURED state;
//     it survives compaction (the nudge text says so), so reading it cannot
//     confabulate. Reading N tasks to answer "send me the project status" is the
//     behavior the gate WANTS, not hoarding. (tracker WRITES are structuring, see
//     STRUCTURING_TOOLS; they satisfy the gate outright and never reach the load
//     count.) The loop's cross-turn loop detector still catches a thrash of the
//     SAME read.
// The trainer-reading-its-own-techniques carve-out is per-agent + per-args and so
// stays in loop.ts (isTrainerOwnTechniquesRead), applied at the same count site.
//
// Unlike the old LOADING_TOOLS set, an omission in this internal-state exemption
// can only make the gate slightly MORE eager (over-nudge on a big self-read), the
// safe direction, and the exempt families (own conversation, own tracker) are a
// small stable set, not the sprawling external-tool surface that drifts.
// ════════════════════════════════════════

/** Number of heavy loads (by result size, below) in a single turn before the
 * advisory can fire. Kept at 6 (NOT raised, raising the bar would just mask the
 * real cause). See the D3 note in loop.ts: the advisory ALSO requires context to
 * be near compaction, so the raw count alone never blocks. */
export const LOADING_GATE_THRESHOLD = 6;

/**
 * Text-payload size (in estimated tokens, the loop's own estimateTokens =
 * chars/4) at or above which a successful tool result counts as one heavy load.
 *
 * CALIBRATION (measured 2026-07-08 against ~14k real tool_result rows in the
 * production DB, successful results only, text payload of each result mapped back
 * to its tool via tool_use_id). The floor separates orientation-reads from
 * corpus-loads at the natural gap in the real distribution (median tokens):
 *
 *   BELOW the floor (must NOT count — small reads):
 *     get_current_time            70   (a clock lookup, constant size)
 *     calendar_agenda (empty)      8
 *     user_calendar_agenda        47   (p75 167 — a short agenda)
 *     user_calendar_search        13
 *     contact_search              12
 *     gmail_search (empty hits)    9
 *   ABOVE the floor (must count — real corpus entering context):
 *     web_fetch                  292
 *     load_tool_docs             377   (pulls tool schemas in)
 *     vault_search               396
 *     user_gmail_search          422
 *     memory_grep                458
 *     web_search                 502
 *     memory_search              576
 *     user_gmail_read            963   (p25 396 — a real email body)
 *     user_gmail_inbox          1025
 *     recall_recent_thread      1336   (exempt for a different reason, see header)
 *
 * 250 tokens is ~1000 characters (~150-200 words): the size of a substantive
 * email body, a fetched web page, a source file, or a search result set with real
 * hits. Every real-corpus reader's MEDIAN payload clears it; a time lookup, an
 * empty/short search, and a short agenda all fall below it. A file_read of a tiny
 * config (median 153) not counting is CORRECT: it loads little corpus and applies
 * no compaction pressure, which is the only hazard this gate exists for.
 */
export const LOADING_RESULT_MIN_TOKENS = 250;

/**
 * Reads that are exempt from the heavy-load count no matter how big they are,
 * because they load the agent's OWN state (its recent conversation, its own
 * tracker), not external corpus that summarizes into confabulation. See the
 * header (OPEN-16 / OPEN-2) for the full reasons. Returns true for the recall of
 * the current thread and any tracker read/write (tracker writes are also
 * structuring and satisfy the gate outright; exempting the whole family here
 * keeps a future tracker read tool exempt by construction).
 */
export function isLoadCountExemptRead(name: string): boolean {
  return name === 'recall_recent_thread' || name.startsWith('tracker_');
}

/**
 * "Structuring" tools: calling any of these in a turn proves the agent
 * has somewhere for the loading work to land. Satisfies the gate for
 * the rest of the turn.
 *
 * v2.5.46, scratchpad_set REMOVED from the structuring set. Per the
 * tracker-adoption audit, agents were satisfying the gate with a
 * one-liner scratchpad call (the cheapest escape) and never opening a
 * tracker project. Scratchpad is for in-flight memory INSIDE a tracker
 * step, not a substitute for the durable plan. Now requires a real
 * tracker action or a real file write.
 *
 * HAND-PICKED, and legitimately curated: this is the small set of DURABLE-WRITE
 * tools that prove scaffolding. It is NOT registry-exhaustive on purpose (most
 * tools are neither structuring nor loads), so the conformance tripwire pins only
 * that every name here is a real tool (a rename fails the build); an omission here
 * can at worst make the advisory nudge slightly too eagerly (self-correcting once
 * the agent does write), which is the safe direction and does not earn full
 * registry accounting. The tool-list conformance test states this judgment.
 */
export const STRUCTURING_TOOLS = new Set<string>([
  'tracker_create_project',
  'tracker_create_task',
  'tracker_update_status',
  'tracker_complete_step',
  'tracker_add_notes',
  'tracker_edit_task',
  'file_write',
  'file_append',
  'file_patch',
]);

export function isStructuringTool(name: string): boolean {
  return STRUCTURING_TOOLS.has(name);
}

// D3 removed the count-based refusal (and buildHoardingRefusal, which carried
// contradictory scratchpad_set instructions). Reads are never blocked; the
// loop.ts advisory nudges a durable write only when context is genuinely near
// compaction. The 2026-07-08 rewrite additionally replaced the curated
// LOADING_TOOLS name-set with a measured result-size floor (see header), so
// omission-rot on the reader surface can no longer silently weaken the gate.
