import { callModel } from '../agent/model.js';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { estimateTokens } from './budget.js';

const logger = createLogger('memory-summarize');

// ── Identity Resolution ──

function getIdentityContext(agentId: string): string {
  const db = getDb();

  // Get agent name
  const agent = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
  const agentName = agent?.name ?? 'the assistant';

  // Get user name from config
  const userRow = db.prepare("SELECT value FROM config WHERE key = 'user_name'").get() as { value: string } | undefined;
  const userName = userRow?.value || 'the user';

  return `IDENTITY CONTEXT:
- Messages labeled [USER] are from ${userName}, the human operator
- Messages labeled [ASSISTANT] are from ${agentName}, the AI agent
- Messages labeled [TOOL] are tool execution results
- Always attribute actions and statements to the correct person: "${userName} said/asked/wants..." or "${agentName} did/responded/suggested..."`;
}

// ── Depth-Aware Prompts ──

export function getDepthPrompt(depth: number, targetTokens: number, previousContext?: string, agentId?: string): string {
  const contextBlock = previousContext
    ? `\n\nPrevious context for continuity:\n${previousContext}\n`
    : '';

  const identity = agentId ? getIdentityContext(agentId) : '';

  if (depth === 0) {
    return `You are a factual memory extraction engine. Your job is to preserve EVERY specific fact from the conversation. Factual completeness is more important than narrative flow.

${identity}

INPUT FORMAT: The conversation below is formatted as [ROLE · PARTY] followed by the message content, separated by --- dividers.
[USER · <name>] = an inbound message, tagged with WHO it is from and on which channel (e.g. [USER · the owner], [USER · Alex Chen (imessage)], [USER · priya@northwind.example.com (email)], [USER · a PM agent (agent)])
[ASSISTANT · <party>] / [TOOL · <party>] = the AI assistant's own reply / a tool result, tagged with the conversation it was part of
The PARTY tag tells you which conversation each message belongs to. These are SEPARATE conversations with different people, not one stream.

CONVERSATION ATTRIBUTION — CRITICAL:
- Every fact, request, reminder, pending task, or decision MUST state which party/conversation it belongs to. Write "the owner asked to move their dentist to 3pm" and "Priya (email) asked for the offsite budget" — NEVER an unattributed "dentist moved to 3pm; offsite budget requested" that drops who it was for.
- Keep different parties' items separate. Do not merge a request from one person with an action for another. A later reader uses these labels to act on the RIGHT person's request on the right turn; an unlabeled fact causes it to act on the wrong conversation.

TEMPORAL ANCHORING — CRITICAL:
- Begin the summary with the time period it covers: [YYYY-MM-DD HH:MM – HH:MM] or [YYYY-MM-DD] if timestamps are unclear.
- Preserve ALL dates, times, and temporal references from the original messages.
- When events happened at specific times, include those times in the summary.
- This temporal context is essential — downstream systems use it to judge the age and relevance of information.

ABSOLUTE RULES — NEVER VIOLATE THESE:
- Preserve ALL proper nouns: company names, product names, people's names, place names
- Preserve ALL specific details: numbers, dates, prices, URLs, file paths, version numbers
- Preserve ALL stated preferences: "favorite movie is Meet Joe Black" not "discussed movie preferences"
- Preserve ALL business/project details: "runs Acme Corp (advertising/video production)" not "discussed their businesses"
- Preserve exact quotes when the user states a preference, makes a decision, or gives an instruction
- Preserve ALL technical specifics: error messages, config values, commands run, API responses
- When the user says "X is Y", write "X is Y" — do not generalize to "discussed X"
- Capability / tool availability is VOLATILE state, not a durable fact. Record what was ATTEMPTED and the OUTCOME ("tried to download from the user's account, got a 'no such tool' error"), but NEVER write a standing verdict like "the agent cannot download user attachments" or "that feature isn't supported" — the platform gains tools over time and such verdicts silently go false. Keep the dated attempt, drop the conclusion.
- Note any unresolved questions, pending tasks, or open decisions in the narrative, tagged with the party/conversation they belong to. An OBLIGATION — something still owed to someone — may only be written if the conversation gives you its work id, cited as written (e.g. "still owed: email Bob the roof quote [cmt:1a2b3c4d5e6f]"). If there is no id for it, leave it out: the id is the record, the summary is the context around it. A summary is a record of what was SAID, never of what is currently owed; the OPEN WORK block in the live prompt is the current status, and an obligation line here is history whatever tense it is written in.
- Attribute every fact to the correct person AND the correct conversation, using the [ROLE · PARTY] tags. Carry the party label into the summary text so whose-request-is-whose survives compression.
- CRITICAL — Preserve resolution state. At the end of the summary, include a section:
  RESOLVED: [issue] — fixed [how/when]
  DECIDED: [what was decided and why]
  CLOSED: [task/project name] — completed
  DEFERRED: [item] — [reason it was deprioritized]
  This prevents the agent from re-raising issues that are already handled.
- Never record "I could not see / read / receive a message" as an outstanding item. That is a transient context state, not an unanswered question, and writing it down turns a moment's confusion into a durable belief.
- Target approximately ${targetTokens} tokens — use the space to keep details, not to pad
- Do NOT include preamble — write the factual summary directly

BAD: "The user discussed their work and business ventures"
GOOD: "[2026-04-19 09:00–11:30] The user runs two businesses: Acme Corp (advertising and video production, primary client is BigTech) and SideProject (wedding videography serving the greater metro area)"

BAD: "The user mentioned their entertainment preferences"
GOOD: "The user's favorite movie is Meet Joe Black. Favorite TV show is Schitt's Creek."
${contextBlock}`;
  }

  if (depth === 1) {
    return `You are a factual memory condensation engine. You are merging multiple summaries into a unified overview. Factual completeness is more important than brevity.

${identity}

INPUT FORMAT: Each <summary> block below is a COMPRESSED version of earlier conversation — these are already summarized, not raw messages. They may overlap in time. Merge them, keeping ALL specific details from each.

TEMPORAL ANCHORING — CRITICAL:
- Preserve the time period from each source summary. Each source summary should begin with a date/time range — carry these forward.
- When merging overlapping summaries, note the combined time range at the top: [YYYY-MM-DD to YYYY-MM-DD].
- Within each topic, preserve chronological order so the reader can tell what happened when.
- NEVER strip dates or temporal references — they are essential for judging relevance downstream.

ABSOLUTE RULES:
- Preserve ALL proper nouns, specific names, numbers, dates, and concrete details from the source summaries
- When two summaries mention the same topic, merge them but keep ALL specific details from both
- NEVER generalize specific facts into vague categories — "favorite movie is Meet Joe Black" must survive, not become "has movie preferences"
- NEVER drop business names, project names, people's names, or technical specifics
- Remove only true duplicates (exact same fact stated twice) and filler/pleasantries
- Obligation lines (things owed to someone) carry a work id and, where the engine has resolved it, a bracketed state. Carry BOTH forward verbatim and never restate an obligation as currently owed: the OPEN WORK block is the current status, not these summaries. An obligation with no id does not survive condensation.
- Do NOT carry forward standing capability verdicts ("agent can't do X", "X not supported") as current fact — keep a dated attempt/outcome if one is present, but those conclusions are stale-prone and must not be stated as present truth
- Maintain correct attribution — never confuse who said or did what. The source summaries tag facts with the party/conversation they belong to (the owner, a named contact on a channel, another agent); CARRY THOSE LABELS FORWARD. Keep different parties' requests separate; never merge them into an unattributed statement.
- Target approximately ${targetTokens} tokens — use the space for facts, not narrative
- Do NOT include preamble — write the condensed summary directly
${contextBlock}`;
  }

  // depth >= 2: high-level strategic summary
  return `You are a factual memory condensation engine performing deep condensation (depth ${depth}). Create a comprehensive reference document from multiple condensed summaries.

${identity}

TEMPORAL ANCHORING — CRITICAL:
- Begin the document with the overall date range it covers: [YYYY-MM-DD to YYYY-MM-DD].
- Begin each topic section with the date range it covers (e.g., "## Projects [2026-03-15 to 2026-04-19]").
- Within topics, organize chronologically so the reader can tell what happened when and what is most recent.
- Mark decisions and events with their dates — "Decided on 2026-04-10 to use A2A protocol" not just "Decided to use A2A protocol".
- NEVER strip dates or temporal references — they are essential for judging relevance.

ABSOLUTE RULES:
- This is a REFERENCE DOCUMENT, not a narrative — optimize for fact density
- Preserve ALL proper nouns, specific names, numbers, and concrete details
- Preserve ALL stated preferences, decisions, and instructions from the user
- Preserve ALL business/project details with their specific descriptions
- Organize by topic (e.g., "User Profile", "Projects", "Preferences", "Technical Decisions") with date ranges
- Drop only: routine tool calls, small talk, resolved errors with no lasting impact
- Keep: anything that would be needed to resume a conversation months later
- Obligation lines (things owed to someone) keep their work id and any bracketed state verbatim, and are never restated as currently owed: the OPEN WORK block is the current status, not this document. An obligation with no id does not survive condensation.
- Maintain correct attribution
- Target approximately ${targetTokens} tokens
- Do NOT include preamble — write the reference summary directly
${contextBlock}`;
}

// ── Deterministic Truncation (Level 3 Escalation) ──

export function truncateDeterministic(text: string, targetTokens: number): string {
  const targetChars = targetTokens * 4;

  if (text.length <= targetChars) {
    return text;
  }

  const keepChars = Math.floor(targetChars * 0.4); // 20% front + 20% back = 40% of target
  const frontChars = Math.floor(keepChars / 2);
  const backChars = keepChars - frontChars;

  const omittedTokens = estimateTokens(text.slice(frontChars, text.length - backChars));

  const front = text.slice(0, frontChars);
  const back = text.slice(text.length - backChars);

  return `${front}\n\n[... ${omittedTokens} tokens truncated ...]\n\n${back}`;
}

// ── Main Summarization Function ──

/**
 * THE SUMMARIZER'S RESULT CONTRACT. PHASE-3 T5 Step 2, per 19 §1e.
 *
 * Before this, every path returned `{ text, tokenCount }` and two of them filled `text`
 * with `truncateDeterministic(content)` — the RAW chunk, role tags and all. Research 06 §6
 * names that as one of the two reasons contaminated summaries exist at all: the raw body
 * was persisted, embedded, FTS-indexed and then condensed into depth-1 and depth-2 parents,
 * and a nightly job re-repaired it forever.
 *
 * A refusal is not a placeholder. `NO_CONVERSATION_PLACEHOLDER` is a CLAIM — "this span held
 * no conversation" — and it is true only when the filtered input really is empty, which the
 * caller checks before ever getting here. On the no-model and model-threw paths the claim
 * would be false and the cost of the lie is permanent: marking the sources compacted
 * destroys the rows. `{ok:false, reason}` leaves the span exactly where it was so the next
 * drain tries again.
 */
export type SummaryResult =
  | { ok: true; text: string; tokenCount: number }
  | { ok: false; reason: string };

export async function generateSummary(params: {
  content: string;
  depth: number;
  targetTokens: number;
  agentId: string;
  modelId?: string;
  previousContext?: string;
  // v2.5.14 — Optional abort signal for cancellation. Used by the routine
  // gap-trigger drain so a hanging summarizer call (e.g. provider timeout
  // beyond a sane wall-clock) can actually be cancelled rather than
  // continuing in the background.
  abortSignal?: AbortSignal;
}): Promise<SummaryResult> {
  const { content, depth, targetTokens, agentId, modelId, previousContext, abortSignal } = params;

  // Need a model to summarize with.
  // PHASE-3 T5: this used to return `truncateDeterministic(content)` — the RAW chunk,
  // persisted as if it were a summary. There is no model, so there is no summary; saying so
  // is the only honest answer and it costs nothing but a retry.
  if (!modelId) {
    logger.warn('SUMMARY_REFUSED no model specified for summarization', { depth }, agentId);
    return { ok: false, reason: 'no summarizer model configured for this agent' };
  }

  // Level 1: Normal summarization
  const systemPrompt = getDepthPrompt(depth, targetTokens, previousContext, agentId);

  try {
    logger.info('Generating summary (level 1: normal)', {
      depth,
      targetTokens,
      contentTokens: estimateTokens(content),
    }, agentId);

    const result = await callModel({
      agentId,
      modelId,
      messages: [{ role: 'user', content }],
      systemPrompt,
      tools: false,
      abortSignal,
    });

    const resultTokens = estimateTokens(result.content);

    // Check if result is within acceptable range
    if (resultTokens <= targetTokens * 1.5) {
      logger.info('Summary generated (level 1: normal)', {
        depth,
        resultTokens,
        targetTokens,
      }, agentId);
      return { ok: true, text: result.content, tokenCount: resultTokens };
    }

    // Level 2: Aggressive retry
    logger.info('Summary too large, retrying (level 2: aggressive)', {
      depth,
      resultTokens,
      targetTokens,
    }, agentId);

    const aggressivePrompt = `Be much more aggressive in condensing. The previous attempt produced ${resultTokens} tokens but the target is ${Math.floor(targetTokens / 2)} tokens. Cut ruthlessly — keep only the most critical facts.\n\n${systemPrompt}`;

    const aggressiveResult = await callModel({
      agentId,
      modelId,
      messages: [{ role: 'user', content: result.content }],
      systemPrompt: aggressivePrompt,
      tools: false,
      abortSignal,
    });

    const aggressiveTokens = estimateTokens(aggressiveResult.content);

    if (aggressiveTokens <= targetTokens * 1.5) {
      logger.info('Summary generated (level 2: aggressive)', {
        depth,
        resultTokens: aggressiveTokens,
        targetTokens,
      }, agentId);
      return { ok: true, text: aggressiveResult.content, tokenCount: aggressiveTokens };
    }

    // Level 3: Deterministic truncation (always succeeds)
    logger.warn('Summarization still too large, using deterministic truncation (level 3)', {
      depth,
      aggressiveTokens,
      targetTokens,
    }, agentId);

    // STILL ok:true, deliberately: this truncates the MODEL'S OWN OUTPUT, which has already
    // been through the summariser twice and carries no raw rows. It is a shorter summary,
    // not a raw body wearing a summary's name.
    const truncated = truncateDeterministic(aggressiveResult.content, targetTokens);
    return { ok: true, text: truncated, tokenCount: estimateTokens(truncated) };
  } catch (err) {
    // PHASE-3 T5: this used to truncate the RAW input and persist it. The model failing is
    // not a reason to write the conversation back into the summary store verbatim.
    const message = err instanceof Error ? err.message : String(err);
    logger.error('SUMMARY_REFUSED summarization model call failed', {
      error: message, depth, targetTokens,
    }, agentId);
    return { ok: false, reason: `summarizer model call failed: ${message}` };
  }
}
