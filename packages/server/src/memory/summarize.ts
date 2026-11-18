import { callModel } from '../agent/model.js';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { estimateTokens } from './budget.js';
import type { ProviderErrorFacts } from '../agent/provider-error.js';
import { isContextOverflowError } from '../agent/context-overflow.js';
import { writeThenCheck, rewriteInstruction } from './summary-check.js';
import { settleSummaryCall, refuseWhatTheWriterCannotHold, refuseFallbackOverFreeMemory, summaryCallStarts } from './writer.js';
import { noteSummaryCallFailed } from '../agent/failed-call.js';
import { summaryConversationLabel, LabelFacts } from './summary-subject.js';
import { renderInstant } from './message-stamp.js';
import { writeWhole } from './summary-whole.js';
import { modelCharsPerToken } from '../services/token-density.js';
import type { Summary } from './dag.js';

const logger = createLogger('memory-summarize');

// An inbound row is from whoever its PARTY tag names, so only the agent's own name is given: calling every
// sender the operator made a notice read as the owner's request.
function getIdentityContext(agentId: string): string {
  const agent = getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
  const agentName = agent?.name ?? 'the assistant';
  return `IDENTITY CONTEXT:
- Messages labeled [ASSISTANT] are from ${agentName}, the AI agent; [TOOL] are its tool results
- Messages labeled [USER] are inbound, from the party their tag names — never assume who without the tag
- Attribute every statement to the party its tag names: "<that party> asked…", "${agentName} did…"`;
}

/** The one condensed-input builder (the condenser and the nightly rebuild both read it): each note carries
 *  the conversation it is about and its recorded range. */
export function condensedSummaryInput(batch: readonly Summary[]): string {
  const labels = new LabelFacts(batch[0]?.agentId ?? '');
  return batch.map((s) => {
    const label = summaryConversationLabel(s, labels);
    const earliest = renderInstant(s.earliestAt) ?? s.earliestAt;
    const latest = renderInstant(s.latestAt) ?? s.latestAt;
    return `<summary id="${s.id}" depth="${s.depth}" conversation="${label}" earliest="${earliest}" latest="${latest}">\n${s.content}\n</summary>`;
  }).join('\n\n');
}

export function getDepthPrompt(depth: number, targetTokens: number, agentId?: string): string {
  const identity = agentId ? getIdentityContext(agentId) : '';

  if (depth === 0) {
    return `You are a factual memory extraction engine. Your job is to preserve EVERY specific fact from the conversation. Factual completeness is more important than narrative flow.

${identity}

INPUT FORMAT: The input opens with a CONVERSATION line naming the ONE conversation every message below belongs to (a dashboard conversation, an email thread, an agent thread, engine events…). Each message is then [ROLE · PARTY · RECORDED TIME] followed by its content, separated by --- dividers.
[USER · <name>] = an inbound message, tagged with WHO it is from and on which channel (e.g. [USER · <a contact> (imessage)], [USER · <an address> (email)], [USER · a PM agent (agent)])
[ASSISTANT · <party>] / [TOOL · <party>] = the AI assistant's own reply / a tool result
Every tag then ends with that message's RECORDED TIME: [USER · <name> · Oct 1, 2026, 09:00 AM UTC-07:00].
The RECORDED TIME is when that message was written: it is your only source of dates. If there is no CONVERSATION line, each tag names its own conversation ("in <conversation>"): keep those conversations apart, never merge them.
[USER · <name> · ANSWERED in turn <N>] = the engine's own record that this ask WAS ALREADY ANSWERED, on turn N. Carry that state into the summary — write "asked X; answered on turn N" — and NEVER list such an ask as outstanding, pending, or awaiting a reply. An ask with no ANSWERED tag is simply an ask; say what was asked, not that it is still owed.

CONVERSATION ATTRIBUTION — CRITICAL:
- Every fact, request, reminder or decision MUST state which party/conversation it belongs to (its PARTY tag). Write "the owner asked to move their dentist to 3pm" and "<that contact> (email) asked for the offsite budget" — NEVER an unattributed "dentist moved to 3pm".
- Do not merge a request from one person with an action for another.

TEMPORAL ANCHORING — CRITICAL:
- Begin the summary with the time period it covers, from the first and last RECORDED TIME: [YYYY-MM-DD HH:MM – HH:MM]. Every message carries its time, so never write "date unknown".
- Preserve ALL dates, times, and temporal references from the original messages.
- When events happened at specific times, include those times in the summary.
- This temporal context is essential — downstream systems use it to judge the age and relevance of information.

ABSOLUTE RULES — NEVER VIOLATE THESE:
- Preserve ALL proper nouns: company names, product names, people's names, place names
- Preserve ALL specific details: numbers, dates, prices, URLs, file paths, version numbers
- Preserve ALL stated preferences: "favorite tea is jasmine green" not "discussed drink preferences"
- Preserve ALL business/project details: "runs Acme Corp (advertising/video production)" not "discussed their businesses"
- Preserve exact quotes when the user states a preference, makes a decision, or gives an instruction
- Preserve ALL technical specifics: error messages, config values, commands run, API responses
- A tool result shown only in part says so and names the id its whole is kept under: record what the shown part found and keep that id beside it, so the agent can read the rest again
- When the user says "X is Y", write "X is Y" — do not generalize to "discussed X"
- Capability / tool availability is VOLATILE state, not a durable fact. Record what was ATTEMPTED and the OUTCOME ("tried to download from the user's account, got a 'no such tool' error"), but NEVER write a standing verdict like "the agent cannot download user attachments" or "that feature isn't supported" — the platform gains tools over time and such verdicts silently go false. Keep the dated attempt, drop the conclusion.
- Record each request WITH ITS OUTCOME as these messages show it, dated: answered, done, declined, or "not answered by <last recorded time>". A summary is a record of what was SAID and DONE, never of what is CURRENT: never write "pending", "outstanding", "next steps" or "still owed" as present fact — the OPEN WORK block (the task list) in the live prompt is the only record of what is current. An obligation may be named only with the work id the conversation gives you, cited as written (e.g. "agreed to email <that contact> the roof quote [cmt:1a2b3c4d5e6f]"). If there is no id for it, leave it out: the id is the record, the summary is the context around it.
- Attribute every fact to the correct person, using the [ROLE · PARTY · TIME] tags, and carry the party label into the summary text.
- CRITICAL — Preserve resolution state. At the end of the summary, include a section:
  RESOLVED: [issue] — fixed [how/when]
  DECIDED: [what was decided and why]
  CLOSED: [task/project name] — completed
  DEFERRED: [item] — [reason it was deprioritized]
  This prevents the agent from re-raising issues that are already handled.
- Never record "I could not see / read / receive a message" as an outstanding item. That is a transient context state, not an unanswered question, and writing it down turns a moment's confusion into a durable belief.
- Target approximately ${targetTokens} tokens, sized to this input — use the space to keep details, not to pad, and never write more than the input itself
- Do NOT include preamble — write the factual summary directly

BAD: "The user discussed their work and business ventures"
GOOD: "[2026-04-19 09:00–11:30] The user runs two businesses: Acme Corp (advertising and video production, primary client is BigTech) and SideProject (wedding videography serving the greater metro area)"

BAD: "The user mentioned their drink and hobby preferences"
GOOD: "The user's favorite tea is jasmine green. Favorite board game is chess."
`;
  }

  if (depth === 1) {
    return `You are a factual memory condensation engine. You are merging multiple summaries into a unified overview. Factual completeness is more important than brevity.

${identity}

INPUT FORMAT: Each <summary> block below is a COMPRESSED version of earlier conversation — already summarized, not raw messages. Its conversation="…" attribute names the ONE conversation it records, and earliest/latest are its recorded range. Merge them, keeping ALL specific details from each.

CONVERSATIONS — CRITICAL:
- When every block names the same conversation, begin with "Conversation: <that name>".
- When they name several (rare: memory had to shrink further), keep each conversation's facts under its own heading with its name and range. Never merge two conversations' facts.

RESOLUTION STATE — CRITICAL:
- Carry every RESOLVED / DECIDED / CLOSED / DEFERRED line forward, merged into one such section at the end, so settled issues are never re-raised.
- Never state what is currently pending or owed: the OPEN WORK block (the task list) is the only record of what is current.

TEMPORAL ANCHORING — CRITICAL:
- Preserve the time period from each source summary. Each source summary should begin with a date/time range — carry these forward.
- When merging overlapping summaries, note the combined time range at the top: [YYYY-MM-DD to YYYY-MM-DD].
- Within each topic, preserve chronological order so the reader can tell what happened when.
- NEVER strip dates or temporal references — they are essential for judging relevance downstream.

ABSOLUTE RULES:
- Preserve ALL proper nouns, specific names, numbers, dates, and concrete details from the source summaries — every id, code and amount copied exactly as written
- When two summaries mention the same topic, merge them but keep ALL specific details from both
- NEVER generalize specific facts into vague categories — "favorite tea is jasmine green" must survive, not become "has drink preferences"
- NEVER drop business names, project names, people's names, or technical specifics
- Remove only true duplicates (exact same fact stated twice) and filler/pleasantries
- Obligation lines (things owed to someone) carry a work id and, where the engine has resolved it, a bracketed state. Carry BOTH forward verbatim and never restate an obligation as currently owed: the OPEN WORK block is the current status, not these summaries. An obligation with no id does not survive condensation.
- Do NOT carry forward standing capability verdicts ("agent can't do X", "X not supported") as current fact — keep a dated attempt/outcome if one is present, but those conclusions are stale-prone and must not be stated as present truth
- Maintain correct attribution — never confuse who said or did what. CARRY the party and conversation labels forward; never merge different parties' requests into an unattributed statement.
- Target approximately ${targetTokens} tokens, sized to these summaries — use the space for facts, not narrative
- Do NOT include preamble — write the condensed summary directly
`;
  }

  // depth >= 2: high-level strategic summary
  return `You are a factual memory condensation engine performing deep condensation (depth ${depth}). Create a comprehensive reference document from multiple condensed summaries.

${identity}

TEMPORAL ANCHORING — CRITICAL:
- Begin the document with its conversation (from the conversation="…" attributes; one heading per conversation if they name several) and the overall date range it covers: [YYYY-MM-DD to YYYY-MM-DD].
- Begin each topic section with the date range it covers (e.g., "## Projects [2026-03-15 to 2026-04-19]").
- Within topics, organize chronologically so the reader can tell what happened when and what is most recent.
- Mark decisions and events with their dates — "Decided on 2026-04-10 to use A2A protocol" not just "Decided to use A2A protocol".
- NEVER strip dates or temporal references — they are essential for judging relevance.

ABSOLUTE RULES:
- This is a REFERENCE DOCUMENT, not a narrative — optimize for fact density
- Preserve ALL proper nouns, specific names, numbers, and concrete details — every id, code and amount copied exactly as written
- Preserve ALL stated preferences and decisions, and every instruction WITH its outcome as the sources record it (done, answered, declined, superseded) — an instruction is history, not a standing order
- Carry every RESOLVED / DECIDED / CLOSED / DEFERRED line forward into one section at the end; never state what is currently pending or owed (the OPEN WORK block, the task list, is the only record of what is current)
- Preserve ALL business/project details with their specific descriptions
- Organize by topic (e.g., "User Profile", "Projects", "Preferences", "Technical Decisions") with date ranges
- Drop only: routine tool calls, small talk, resolved errors with no lasting impact
- Keep: anything that would be needed to resume a conversation months later
- Obligation lines (things owed to someone) keep their work id and any bracketed state verbatim, and are never restated as currently owed: the OPEN WORK block is the current status, not this document. An obligation with no id does not survive condensation.
- Maintain correct attribution
- Target approximately ${targetTokens} tokens, sized to these summaries
- Do NOT include preamble — write the reference summary directly
`;
}

/**
 * The result contract: a refusal is never a placeholder or the raw chunk. `NO_CONVERSATION_PLACEHOLDER` claims the
 * span held no conversation, true only when the filtered input is empty (the caller checks); marking sources
 * compacted destroys rows, so `{ok:false, reason}` leaves the span for the next drain.
 */
export type SummaryResult =
  | { ok: true; text: string; tokenCount: number }
  | { ok: false; reason: string; stopped?: true; tooBig?: true; noRoom?: true; forNow?: true; checkFailed?: true };   // see writer.ts, summary-check.ts

/**
 * An empty or aborted body is a refusal, not a summary: this path reclaims rows, so an empty string kept as a
 * summary destroys its sources. An abort can also land mid-body, and a truncated span read as whole is the same lie.
 */
function unusableOutput(text: string, abortSignal?: AbortSignal): string | null {
  if (abortSignal?.aborted) return 'summarizer call was aborted before it finished';
  if (!text || text.trim().length === 0) return 'summarizer returned empty text';
  return null;
}

/** The one door: every summary call's outcome is settled against its writer (`writer.ts`), then checked. */
export async function generateSummary(params: Parameters<typeof writeSummary>[0]): Promise<SummaryResult> {
  // Written, then checked against its source before anything keeps it (`summary-check.ts`).
  return writeThenCheck(params, async (p) => settleSummaryCall(await writeSummary(p), p.agentId, p.modelId, p.abortSignal));
}

async function writeSummary(params: {
  content: string;
  depth: number;
  targetTokens: number;
  agentId: string;
  modelId?: string;
  // Cancels the routine gap-trigger drain's call so a hanging summarizer cannot continue in the background.
  abortSignal?: AbortSignal;
  checkFeedback?: string;   // the rewrite after a failed accuracy check names what failed
  spanIds?: readonly string[];   // the rows summarised: a span whose check failed is known by them
  spanOpen?: boolean;   // the last chunk of a fold, still growing (see summary-check.ts writeThenCheck)
}): Promise<SummaryResult> {
  const { content, depth, targetTokens, agentId, modelId, abortSignal, checkFeedback } = params;

  // No model means no summary: saying so costs only a retry, where persisting the raw chunk would pass as one.
  if (!modelId) {
    logger.warn('SUMMARY_REFUSED no model specified for summarization', { depth }, agentId);
    return { ok: false, reason: 'no summarizer model configured for this agent' };
  }

  const systemPrompt = getDepthPrompt(depth, targetTokens, agentId) + rewriteInstruction(checkFeedback);
  const tooBig = refuseWhatTheWriterCannotHold(modelId, systemPrompt, content, agentId) ?? await refuseFallbackOverFreeMemory(modelId, systemPrompt, content, targetTokens, agentId);
  if (tooBig) return tooBig;

  try {
    logger.info('Generating summary', { depth, targetTokens, contentTokens: estimateTokens(content) }, agentId);
    // Every call reads the SOURCE and declares the summary dial (thinking off where the transport can switch it,
    // output room sized to the target); a cut or over-long answer is never kept as whole (`summary-whole.ts`).
    return await writeWhole({
      content, depth, targetTokens, abortSignal,
      warn: (message, meta) => logger.warn(message, meta, agentId),
      charsPerToken: modelCharsPerToken(modelId),   // the writer's own density
      fits: (extra) => refuseWhatTheWriterCannotHold(modelId, systemPrompt + extra, content, agentId) === null,
      call: async (extra, outputRoomAsk) => {
        summaryCallStarts.getStore()?.();
        const result = await callModel({
          agentId, modelId, messages: [{ role: 'user', content }], systemPrompt: systemPrompt + extra, tools: false,
          purpose: 'memory_summarize', utilityTargetTokens: targetTokens, abortSignal,
          ...(outputRoomAsk ? { outputRoomAsk } : {}),
        });
        const unusable = unusableOutput(result.content, abortSignal);
        if (unusable) logger.warn('SUMMARY_REFUSED summarizer produced no usable text', { depth, targetTokens, reason: unusable, stopReason: result.stopReason }, agentId);
        return result;
      },
    });
  } catch (err) {
    // A model failure is never a reason to write the input back into the summary store verbatim.
    const message = err instanceof Error ? err.message : String(err);
    // The writer's own "too long" answer is `tooBig` (halve, or the next writer that holds it), not a failure.
    if (isContextOverflowError(message)) { logger.warn('SUMMARY_REFUSED the writer said the input is too long', { modelId, depth }, agentId); return { ok: false, reason: 'the summary writer cannot hold this input', tooBig: true }; }
    // A permanent failure (no balance, dead credential, refused access) opens the provider's breaker, which the
    // chunk loop reads and stops on; transient ones return `ok:false` and retry next drain. Classify from the
    // throw's structured `provider` facts, not the wrapped message prose, and without importing `AgentError`.
    const facts = (err as { provider?: ProviderErrorFacts | null } | null)?.provider ?? undefined;
    noteSummaryCallFailed({ modelId, message, agentId, facts, depth, targetTokens, abortSignal });   // not for a call its caller stopped
    return { ok: false, reason: `summarizer model call failed: ${message}` };
  }
}
