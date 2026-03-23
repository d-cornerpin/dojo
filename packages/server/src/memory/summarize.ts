import { callModel } from '../agent/model.js';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { estimateTokens } from './store.js';

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

ABSOLUTE RULES — NEVER VIOLATE THESE:
- Preserve ALL proper nouns: company names, product names, people's names, place names
- Preserve ALL specific details: numbers, dates, prices, URLs, file paths, version numbers
- Preserve ALL stated preferences: "favorite movie is Meet Joe Black" not "discussed movie preferences"
- Preserve ALL business/project details: "runs Acme Corp (advertising/video production)" not "discussed their businesses"
- Preserve exact quotes when the user states a preference, makes a decision, or gives an instruction
- Preserve ALL technical specifics: error messages, config values, commands run, API responses
- When the user says "X is Y", write "X is Y" — do not generalize to "discussed X"
- Note any unresolved questions, pending tasks, or open decisions
- Attribute every fact to the correct person
- CRITICAL — Preserve resolution state. At the end of the summary, include a section:
  RESOLVED: [issue] — fixed [how/when]
  DECIDED: [what was decided and why]
  CLOSED: [task/project name] — completed
  DEFERRED: [item] — [reason it was deprioritized]
  This prevents the agent from re-raising issues that are already handled.
- Target approximately ${targetTokens} tokens — use the space to keep details, not to pad
- Do NOT include preamble — write the factual summary directly

BAD: "The user discussed their work and business ventures"
GOOD: "The user runs two businesses: Acme Corp (advertising and video production, primary client is BigTech) and SideProject (wedding videography serving the greater metro area)"

BAD: "The user mentioned their entertainment preferences"
GOOD: "The user's favorite movie is Meet Joe Black. Favorite TV show is Schitt's Creek."
${contextBlock}`;
  }

  if (depth === 1) {
    return `You are a factual memory condensation engine. You are merging multiple summaries into a unified overview. Factual completeness is more important than brevity.

${identity}

ABSOLUTE RULES:
- Preserve ALL proper nouns, specific names, numbers, dates, and concrete details from the source summaries
- When two summaries mention the same topic, merge them but keep ALL specific details from both
- NEVER generalize specific facts into vague categories — "favorite movie is Meet Joe Black" must survive, not become "has movie preferences"
- NEVER drop business names, project names, people's names, or technical specifics
- Remove only true duplicates (exact same fact stated twice) and filler/pleasantries
- Maintain correct attribution — never confuse who said or did what
- Target approximately ${targetTokens} tokens — use the space for facts, not narrative
- Do NOT include preamble — write the condensed summary directly
${contextBlock}`;
  }

  // depth >= 2: high-level strategic summary
  return `You are a factual memory condensation engine performing deep condensation (depth ${depth}). Create a comprehensive reference document from multiple condensed summaries.

${identity}

ABSOLUTE RULES:
- This is a REFERENCE DOCUMENT, not a narrative — optimize for fact density
- Preserve ALL proper nouns, specific names, numbers, and concrete details
- Preserve ALL stated preferences, decisions, and instructions from the user
- Preserve ALL business/project details with their specific descriptions
- Organize by topic (e.g., "User Profile", "Projects", "Preferences", "Technical Decisions") rather than chronologically
- Drop only: routine tool calls, small talk, resolved errors with no lasting impact
- Keep: anything that would be needed to resume a conversation months later
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

export async function generateSummary(params: {
  content: string;
  depth: number;
  targetTokens: number;
  agentId: string;
  modelId?: string;
  previousContext?: string;
}): Promise<{ text: string; tokenCount: number }> {
  const { content, depth, targetTokens, agentId, modelId, previousContext } = params;

  // Need a model to summarize with
  if (!modelId) {
    logger.warn('No model specified for summarization, using deterministic truncation', {}, agentId);
    const text = truncateDeterministic(content, targetTokens);
    return { text, tokenCount: estimateTokens(text) };
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
    });

    const resultTokens = estimateTokens(result.content);

    // Check if result is within acceptable range
    if (resultTokens <= targetTokens * 1.5) {
      logger.info('Summary generated (level 1: normal)', {
        depth,
        resultTokens,
        targetTokens,
      }, agentId);
      return { text: result.content, tokenCount: resultTokens };
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
    });

    const aggressiveTokens = estimateTokens(aggressiveResult.content);

    if (aggressiveTokens <= targetTokens * 1.5) {
      logger.info('Summary generated (level 2: aggressive)', {
        depth,
        resultTokens: aggressiveTokens,
        targetTokens,
      }, agentId);
      return { text: aggressiveResult.content, tokenCount: aggressiveTokens };
    }

    // Level 3: Deterministic truncation (always succeeds)
    logger.warn('Summarization still too large, using deterministic truncation (level 3)', {
      depth,
      aggressiveTokens,
      targetTokens,
    }, agentId);

    const truncated = truncateDeterministic(aggressiveResult.content, targetTokens);
    return { text: truncated, tokenCount: estimateTokens(truncated) };
  } catch (err) {
    // If model call fails entirely, fall back to deterministic truncation
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Summarization model call failed, using deterministic truncation', {
      error: message,
      depth,
      targetTokens,
    }, agentId);

    const truncated = truncateDeterministic(content, targetTokens);
    return { text: truncated, tokenCount: estimateTokens(truncated) };
  }
}
