import type Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { assembleSystemPrompt, type PromptTurnContext } from '../prompt/assembler.js';
import { getContextWindow } from '../agent/model.js';
import { estimateTokens, getRecentMessages } from './store.js';
import { getContextSummaries } from './dag.js';
import { getLatestBriefing } from './briefing.js';
import { retrieveForContext } from '../vault/retrieval.js';
import { isPMAgent } from '../config/platform.js';
// (getRuntimeVersion import removed in Phase 9 Stage 2 — single-track v2)
import { turnBoundary } from '../agent/turn-state.js';
import type { Summary } from './dag.js';
import type { Message } from '@dojo/shared';

const logger = createLogger('memory-assembler');

const DEFAULTS = {
  contextThreshold: 0.75,
};

// ── Per-tool-result cap (Part V + Part XVIII §A) ──
// Raw tool results stay capped at assembly time so a single oversized
// tool result can't dominate context. Always enforced — the runtime
// version flag was removed in Phase 9 Stage 2.
//
// v2.7.3 — raised from 3000 → 15000 tokens. The v2.7.2 release bumped
// file_read's execution cap from 8K → 60K tokens, but the assembler
// re-truncated tool_result blocks back down to 3K (~12K chars, roughly
// "8000 characters" by the user's eyeball estimate) on every subsequent
// turn — so the bigger read at execution time was invisible from turn 2
// onward, defeating the bump. 15K tokens (~60K chars, ~30 pages) lets a
// typical document the agent just read stay intact through the rest of
// the session, while still preventing one runaway result from blowing
// the entire context budget on a 200K-window model.
const V2_MAX_TOOL_RESULT_TOKENS = 15000;

// ── v2 stub-and-store age (Part XVIII §E) ──
// After this many turns, a tool_result message in the assembled context
// gets replaced by a stub. Combined with the vault as long-term memory
// (§C), the agent doesn't need the raw result kept around.
//
// v2.7.3 — raised from 5 → 12. Paired with the V2_MAX_TOOL_RESULT_TOKENS
// bump above: lifting the per-result cap didn't help if the result was
// stubbed out 5 turns later. A "read doc → think → make changes" cycle
// routinely spans 6-10 turns; under the old threshold the source doc
// was already gone by the time the agent was acting on it, forcing a
// re-read (and burning the assembler-cap retruncate cycle again). 12
// covers the typical workflow without letting tool results accumulate
// indefinitely on long-running agents. The fresh-tail count (80 on a
// 200K model, 64 on 128K, 40 on 32K) still bounds how many turns are
// ever visible to the assembler, so this number caps "alive within the
// visible window" rather than total memory growth.
const V2_STUB_AFTER_TURNS = 12;

// v2.7.6 — the v2.7.4 1-turn override for technique tool results
// has been REMOVED. It tried to enforce freshness by stubbing
// technique reads on the next turn so the agent would have to
// re-call to access the content. With v2.7.6's technique-ack gate
// (loop.ts: pendingTechniqueAck), every fresh load now forces an
// explicit acknowledgement before any other tool can run — that's
// the engagement enforcement.
//
// Keeping both produced a loop: agent reads → gate engages → agent
// acks → next turn the read is stubbed → agent re-reads → gate
// re-engages → agent re-acks → ... forever. The gate is the
// stronger and correct mechanism; stubbing was a weaker indirect
// attempt at the same goal. Technique reads now use the generic
// V2_STUB_AFTER_TURNS like every other tool result.

// ── Stale-summary scrub against fresh technique reads (v2.7.7) ──
//
// reset_session deliberately preserves summaries to keep project
// context across resets, but pre-existing summaries describe the
// PRIOR version of any technique the agent has freshly re-read this
// session. Real failure mode reported on prod: agent reads the
// current "M365 Campaign Demo Builder" technique, but its summaries
// from the prior session still describe an OLD workflow with a
// `campaign_runner.py` script that no longer exists in the current
// technique. The agent reads the fresh technique correctly, but then
// references the old script because the summary says they used it
// "last time."
//
// Fix: at assembly time, find techniques that have been freshly read
// recently (sentinel-bearing tool_results in the fresh tail). For
// each such technique, replace any summary whose content mentions
// the technique name with a stub. The fresh read is the source of
// truth; summaries describing earlier versions are noise at best
// and contradictions at worst.
const TECHNIQUE_FRESH_SENTINEL = '══ TECHNIQUE FRESH READ ══';

function extractFreshlyReadTechniques(messages: Message[]): Set<string> {
  const names = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    let blocks: unknown;
    try {
      blocks = JSON.parse(m.content);
    } catch {
      continue;
    }
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      const b = block as { type?: string; content?: unknown };
      if (b.type !== 'tool_result' || typeof b.content !== 'string') continue;
      // wrapTechniqueResult emits exactly:
      //   `══ TECHNIQUE FRESH READ ══ <name> (<timestamp>)\n...`
      const m2 = b.content.match(/^══ TECHNIQUE FRESH READ ══ (.+?) \(/);
      if (m2) names.add(m2[1]);
    }
  }
  return names;
}

interface SummaryLike { id: string; content: string; tokenCount: number; }

function scrubSummariesAgainstFreshTechniques<S extends SummaryLike>(
  summaries: S[],
  freshTechniqueNames: Set<string>,
): S[] {
  if (freshTechniqueNames.size === 0) return summaries;
  const lowered = [...freshTechniqueNames].map((n) => n.toLowerCase());
  return summaries.map((s) => {
    const contentLower = s.content.toLowerCase();
    const mentionedNames = lowered.filter((n) => contentLower.includes(n));
    if (mentionedNames.length === 0) return s;
    // Restore display-case version of the names for the stub message.
    const displayNames = [...freshTechniqueNames].filter((n) =>
      mentionedNames.includes(n.toLowerCase()),
    );
    const stub =
      `[STALE SUMMARY CLEARED by engine] — this summary referenced technique${displayNames.length === 1 ? '' : 's'} ` +
      `"${displayNames.join('", "')}" which you have just read freshly in this session. ` +
      `Summaries describe a PRIOR version of the technique and may reference scripts, workflows, or steps ` +
      `that no longer exist on disk. Use the current technique_read result as the source of truth — do NOT ` +
      `paraphrase from this summary or assume "last time we did X" still applies. If you need detail from ` +
      `the technique, call technique_read again. Original summary was ${s.content.length} chars.`;
    return { ...s, content: stub, tokenCount: estimateTokens(stub) };
  });
}

// Model-aware tail sizing: use more of the context window for fresh messages
// instead of a fixed count. Larger models keep more raw conversation.
function getFreshTailCount(contextWindow: number): number {
  if (contextWindow >= 200000) return 80;   // 200k+ (Sonnet, Opus) — ~15-20 turns
  if (contextWindow >= 128000) return 64;   // 128k (GPT-4o) — ~12-15 turns
  if (contextWindow >= 32000) return 40;    // 32k models — ~8-10 turns
  return 24;                                 // Small models — ~5 turns
}

// ── Context Assembly ──

export async function assembleContext(
  agentId: string,
  modelId: string,
  turnContext?: PromptTurnContext,
): Promise<{
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }>;
}> {
  const contextWindow = getContextWindow(modelId);
  // Reserve 10K tokens for tool definitions (they're added by the model layer, not here)
  // and output tokens. The assembler only controls system prompt + messages.
  const toolAndOutputReserve = 15000;
  const maxTokens = Math.floor(DEFAULTS.contextThreshold * contextWindow) - toolAndOutputReserve;

  // 1. System prompt
  const systemPrompt = assembleSystemPrompt(agentId, modelId, turnContext);
  let usedTokens = estimateTokens(systemPrompt);

  const messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }> = [];

  // PM agent gets a lightweight context: system prompt + recent messages only.
  // No briefing, no vault, no summaries. The tracker is its memory.
  if (isPMAgent(agentId)) {
    const freshTail = getRecentMessages(agentId, 10);
    const tailMessages = budgetFreshTail(freshTail, maxTokens - usedTokens);
    const sanitized = sanitizeToolPairs(tailMessages);

    for (const msg of sanitized) {
      const parsed = parseMessageContent(msg);
      if (msg.role === 'tool') {
        messages.push({ role: 'user', content: parsed as Anthropic.ContentBlockParam[] });
      } else if (msg.role === 'user' || msg.role === 'assistant') {
        messages.push({ role: msg.role, content: parsed });
      }
    }

    // Ensure starts with user role
    while (messages.length > 0 && messages[0].role !== 'user') messages.shift();

    logger.debug('PM agent context assembled (lightweight)', {
      agentId,
      systemTokens: usedTokens,
      messageCount: messages.length,
    }, agentId);

    return { systemPrompt, messages };
  }

  // Track whether any scaffolding section was injected so we can push a
  // single combined ack at the end (instead of one ack per section).
  let injectedAnyScaffolding = false;

  // ── v2 scaffolding gating (Part V + Part XVIII §C; v2.9.20 post-
  // compaction re-fire) ──
  //
  // In v1, scaffolding (briefing/vault/tracker/continuity) injects every
  // turn — costing 5–10K tokens per turn even when nothing is new. In v2,
  // scaffolding injects ONLY on session-start turns (first turn after a
  // session reset, or first turn ever for an agent). Mid-session turns
  // skip scaffolding entirely. The agent retrieves anything they need
  // on demand via vault_search / tracker_get_status / etc.
  //
  // v2.9.20: that original design assumed the agent would *know* to
  // retrieve. After compaction, the live tail can lose enough
  // procedural context that the agent doesn't realize it should
  // re-establish — Mike's 2026-06-06 photo-album incident showed the
  // agent literally "felt like a brand new session" when scaffolding
  // had last fired 30 turns earlier despite multiple compactions in
  // between. So now we ALSO fire scaffolding for a window after each
  // compaction. The window expires (we don't pay v1's per-turn cost
  // forever) but covers enough turns for the agent to re-internalise
  // its project context.
  const isSessionStartTurn = isV2SessionStart(agentId);
  const isWithinPostCompactionScaffoldingWindow = (() => {
    try {
      const configRow = getDb().prepare('SELECT config FROM agents WHERE id = ?').get(agentId) as { config: string } | undefined;
      if (!configRow?.config) return false;
      const cfg = JSON.parse(configRow.config) as Record<string, unknown>;
      const validUntil = cfg.continuityBriefValidUntilTurn as number | undefined;
      if (typeof validUntil !== 'number' || validUntil <= 0) return false;
      const turnRow = getDb()
        .prepare('SELECT MAX(turn_number) AS max_turn FROM messages WHERE agent_id = ?')
        .get(agentId) as { max_turn: number | null } | undefined;
      const currentTurn = (turnRow?.max_turn ?? 0) + 1;
      // Brief itself injects through turn `validUntil` (3 turns by
      // default). We re-fire the wider scaffolding for an additional
      // 5 turns past that, giving the agent ~8 turns of full context
      // post-compaction to re-establish.
      const SCAFFOLDING_EXTRA_TURNS = 5;
      return currentTurn < validUntil + SCAFFOLDING_EXTRA_TURNS;
    } catch {
      return false;
    }
  })();
  const shouldFireScaffolding = isSessionStartTurn || isWithinPostCompactionScaffoldingWindow;
  if (isWithinPostCompactionScaffoldingWindow && !isSessionStartTurn) {
    logger.info('Re-firing scaffolding within post-compaction window', { agentId }, agentId);
  }

  // 2. Morning briefing — session-start only
  if (shouldFireScaffolding) {
    const briefing = getLatestBriefing(agentId);
    if (briefing) {
      const briefingText = `<briefing generated="${new Date().toISOString().split('T')[0]}">\n${briefing.content}\n</briefing>`;
      const briefingTokens = estimateTokens(briefingText);

      if (usedTokens + briefingTokens < maxTokens) {
        messages.push({ role: 'user', content: briefingText });
        usedTokens += briefingTokens;
        injectedAnyScaffolding = true;
      }
    }
  }

  // 2.5. Vault entries — v1: always; v2: session start only (Part XVIII §C)
  // In v2 the vault is treated as long-term memory injected once at session
  // start, like Claude Code's CLAUDE.md. Per-turn vault retrieval moves to
  // the agent's explicit vault_search calls.
  //
  // Session-start vault content is the union of:
  //   1. Pinned entries (always-load — handled by retrieveForContext)
  //   2. `session_context`-tagged entries (Phase 4 §C — explicit session load)
  //   3. Relevance-ranked entries for the current conversation topic (legacy)
  //
  // This is additive: existing users get their pinned + relevance behavior;
  // new users can opt into the Claude Code pattern by tagging entries
  // `session_context` and pinning the truly always-load ones.
  if (shouldFireScaffolding) {
    try {
      const recentForQuery = getRecentMessages(agentId, 3);
      let queryText = recentForQuery.map(m => m.content).join(' ').slice(0, 500);
      if (queryText.length <= 10) {
        queryText = 'current projects active tasks recent work status updates decisions';
      }
      const vaultResult = await retrieveForContext(queryText, contextWindow, agentId);
      const sections: string[] = [];
      if (vaultResult.section) sections.push(vaultResult.section);

      // Phase 4 §C — also inject session_context-tagged entries that aren't
      // already in the relevance result. Dedupe by entry ID.
      try {
        const { getSessionContextEntries } = await import('../vault/store.js');
        const sessionCtx = getSessionContextEntries();
        const alreadyIncluded = new Set(vaultResult.entryIds);
        const fresh = sessionCtx.filter((e) => !alreadyIncluded.has(e.id));
        if (fresh.length > 0) {
          const lines = fresh.map((e) => `[${e.type}] ${e.content}`);
          const sessionCtxSection =
            `═══ SESSION CONTEXT (vault entries tagged session_context) ═══\n${lines.join('\n\n')}\n═══ END SESSION CONTEXT ═══`;
          sections.push(sessionCtxSection);
        }
      } catch {
        /* best effort */
      }

      if (sections.length > 0) {
        const combined = sections.join('\n\n');
        const vaultTokens = estimateTokens(combined);
        if (usedTokens + vaultTokens < maxTokens) {
          messages.push({ role: 'user', content: combined });
          usedTokens += vaultTokens;
          injectedAnyScaffolding = true;
        }
      }
    } catch (err) {
      logger.warn('Vault context injection failed', {
        error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  }

  // 3. Summaries from context_items
  const rawSummaries = getContextSummaries(agentId);

  // v2.7.7 — scrub summaries that reference techniques the agent has
  // freshly read in the current fresh tail. Pre-existing summaries
  // describe earlier versions of the technique and are the path by
  // which an agent ends up referencing scripts that no longer exist.
  // Cheap recent-window scan: just enough to catch fresh reads.
  let freshlyReadTechniques: Set<string> = new Set();
  try {
    const recentForScrub = getRecentMessages(agentId, 30);
    freshlyReadTechniques = extractFreshlyReadTechniques(recentForScrub);
  } catch { /* best effort — fall back to no scrub */ }
  const summaries = scrubSummariesAgainstFreshTechniques(rawSummaries, freshlyReadTechniques);

  if (summaries.length > 0) {
    // Budget check: drop oldest summaries if they would overflow
    const summariesToInclude = budgetSummaries(summaries, maxTokens - usedTokens);

    if (summariesToInclude.length > 0) {
      const summaryText = summariesToInclude.map(s => formatSummaryXml(s)).join('\n\n');
      const summaryTokens = estimateTokens(summaryText);

      const wrappedText = `═══ COMPRESSED HISTORY (summaries of earlier messages — not live conversation) ═══\nThe following are compressed summaries of older conversation history. These capture key facts and decisions but are NOT live messages. Do not respond to them directly — they are context only.\n\n${summaryText}\n\n═══ END COMPRESSED HISTORY ═══`;

      messages.push({ role: 'user', content: wrappedText });
      usedTokens += summaryTokens;
      injectedAnyScaffolding = true;
    }
  }

  // 3.5. Active task injection — v1: always; v2: session start only AND
  // skip if the last 3 turns already mention any of those task IDs (Part V
  // table). The skip avoids re-injecting the same task block when the agent
  // is already actively discussing those tasks — common right after a
  // session reset where they immediately picked up the work.
  if (shouldFireScaffolding) try {
    const { listTasks } = await import('../tracker/schema.js');
    const activeTasks = listTasks({ status: 'in_progress', assignedTo: agentId });
    if (activeTasks.length > 0) {
      // Skip task scaffolding injection if the last 3 turns already mention
      // these task IDs — no point repeating them in the prompt.
      let allMentionedRecently = false;
      {
        const recent = getRecentMessages(agentId, 6); // ~3 outer turns of msgs
        const recentText = recent.map(m => m.content).join(' ');
        allMentionedRecently = activeTasks.every(t =>
          recentText.includes(t.id) || recentText.includes(t.id.slice(0, 8)),
        );
      }
      if (!allMentionedRecently) {
        const taskLines = activeTasks.slice(0, 5).map(t => {
          let line = `• ${t.title} (ID: ${t.id.slice(0, 8)}, priority: ${t.priority})`;
          if (t.description) line += `\n  Instructions: ${t.description.slice(0, 300)}${t.description.length > 300 ? '...' : ''}`;
          if (t.notes) {
            const lastNote = t.notes.split('\n').filter(Boolean).pop();
            if (lastNote) line += `\n  Last note: ${lastNote.slice(0, 200)}`;
          }
          return line;
        });
        const taskContext = `═══ YOUR ACTIVE TASKS (from tracker — ground truth) ═══\nYou are currently assigned to these in_progress tasks. This is what you should be working on:\n\n${taskLines.join('\n\n')}\n\n═══ END ACTIVE TASKS ═══`;
        const taskTokens = estimateTokens(taskContext);
        if (usedTokens + taskTokens < maxTokens) {
          messages.push({ role: 'user', content: taskContext });
          usedTokens += taskTokens;
          injectedAnyScaffolding = true;
        }
      }
    }
  } catch { /* tracker may not be available */ }

  // 3.7. Continuity brief.
  // v1: inject on every assembly when present.
  // v2 (Phase 4 §C, Part XVIII §C): inject ONLY for the 3 turns after an
  // emergency compaction set continuityBriefValidUntilTurn. After that
  // window the fresh tail is authoritative and the brief falls away.
  // Below, currentTurn = MAX(turn_number)+1 — the same number v2/loop.ts
  // uses to label the in-progress turn.
  try {
    const db = getDb();
    const configRow = db.prepare('SELECT config FROM agents WHERE id = ?').get(agentId) as { config: string } | undefined;
    if (configRow?.config) {
      const agentConfig = JSON.parse(configRow.config) as Record<string, unknown>;
      const continuityBrief = agentConfig.continuityBrief as string | undefined;

      let shouldInjectBrief = false;
      // Inject only if we're inside the validUntilTurn window (set when the
      // brief was generated). Outside that window, the brief is stale and the
      // fresh tail is more authoritative anyway.
      const validUntil = agentConfig.continuityBriefValidUntilTurn as number | undefined;
      if (typeof validUntil === 'number' && validUntil > 0) {
        const turnRow = db
          .prepare('SELECT MAX(turn_number) AS max_turn FROM messages WHERE agent_id = ?')
          .get(agentId) as { max_turn: number | null } | undefined;
        const currentTurn = (turnRow?.max_turn ?? 0) + 1;
        shouldInjectBrief = currentTurn < validUntil;
      }

      if (shouldInjectBrief && continuityBrief && continuityBrief.length > 50) {
        // Wrap with explicit framing so the agent doesn't treat the brief
        // as authoritative when it conflicts with the fresh tail.
        const wrappedBrief = `═══ CONTINUITY BRIEF (snapshot from before the last compaction — the live conversation below is more recent and authoritative when in conflict) ═══\n\n${continuityBrief}\n\n═══ END CONTINUITY BRIEF ═══`;
        const briefTokens = estimateTokens(wrappedBrief);
        if (usedTokens + briefTokens < maxTokens) {
          messages.push({ role: 'user', content: wrappedBrief });
          usedTokens += briefTokens;
          injectedAnyScaffolding = true;
        }
      }
    }
  } catch { /* best effort */ }

  // 3.85. Agent scratchpad — agent-controlled outline / progress / checkpoint
  // surface set via scratchpad_set. Re-injected every turn so the agent's
  // working state survives compaction. Sits just before the ACTIVE USER
  // DIRECTIVE so the directive remains closest to fresh tail.
  try {
    const db = getDb();
    const cfgRow = db.prepare('SELECT config FROM agents WHERE id = ?').get(agentId) as { config: string } | undefined;
    if (cfgRow?.config) {
      const cfg = JSON.parse(cfgRow.config) as Record<string, unknown>;
      const scratchpad = typeof cfg.scratchpad === 'string' ? cfg.scratchpad.trim() : '';
      if (scratchpad.length > 0) {
        const block =
          `═══ YOUR SCRATCHPAD (agent-maintained outline + progress — survives compaction; update with scratchpad_set) ═══\n` +
          `${scratchpad}\n` +
          `═══ END SCRATCHPAD ═══`;
        const scratchTokens = estimateTokens(block);
        if (usedTokens + scratchTokens < maxTokens) {
          messages.push({ role: 'user', content: block });
          usedTokens += scratchTokens;
          injectedAnyScaffolding = true;
        }
      }
    }
  } catch (err) {
    logger.warn('Scratchpad injection failed', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }

  // 3.9. Active user directive — pin the user's most recent substantive ask
  // verbatim, right before the fresh tail. Survives compaction (read fresh
  // from messages every turn), so even when the original prompt has been
  // folded into a summary, the agent still sees what's being asked in the
  // user's own words. This is the "don't forget what we're doing" anchor
  // — the single most important piece of context the system can preserve.
  try {
    const { getActiveUserDirective, formatDirectiveBlock } = await import('./directive.js');
    const directive = getActiveUserDirective(agentId);
    if (directive) {
      const block = formatDirectiveBlock(directive);
      const directiveTokens = estimateTokens(block);
      if (usedTokens + directiveTokens < maxTokens) {
        messages.push({ role: 'user', content: block });
        usedTokens += directiveTokens;
        injectedAnyScaffolding = true;
      }
    }
  } catch (err) {
    logger.warn('Active directive injection failed', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }

  // Single combined ack for ALL scaffolding sections. Pre-2026-05-01 each
  // section pushed its own assistant ack — five separate scaffolding
  // messages. Now one ack closes them all. The ack also names the
  // source-priority hierarchy explicitly so the agent doesn't anchor
  // on a stale brief or vault entry when the live conversation
  // (below) shows different state — a common failure mode that drove
  // verification spirals before this framing was added.
  if (injectedAnyScaffolding) {
    const combinedAck = 'Understood, I have reviewed my background context (briefing, vault, summaries, active tasks, continuity brief, scratchpad, active user directive). Source priority for this turn: active user directive > my scratchpad > live conversation below > active tracker tasks > continuity brief > vault entries > briefing. When sources disagree, trust the most recent and most specific. The active user directive is the WHAT — never lose it. The scratchpad is my own working outline; I maintain it via scratchpad_set as I make progress and read from it when I need to remember where I am.';
    messages.push({ role: 'assistant', content: combinedAck });
    usedTokens += estimateTokens(combinedAck);
  }

  // 4. Fresh tail — exclude user messages that arrived after the current turn
  // started so they get a clean run via the wakeup mechanism instead of being
  // buried mid-context where the LLM might ignore them
  const freshTailCount = getFreshTailCount(contextWindow);
  const turnCutoff = turnBoundary.get(agentId);
  const freshTail = getRecentMessages(agentId, freshTailCount, turnCutoff);

  // Pre-cap oversized tool_result content BEFORE budgeting. capLargeToolResultsInPlace
  // runs later (post-parse, on the in-memory message array) but by then it's too
  // late — budgetFreshTail has already used the raw uncapped token counts to decide
  // what fits. Without this pre-cap, a single 5.9MB tool_result would consume the
  // entire context budget and evict everything older — including the user's
  // actual question — leaving the model with no idea what was being asked.
  const cappedFreshTail = capLargeToolResultStrings(freshTail);

  // Budget: only include messages that fit
  const tailMessages = budgetFreshTail(cappedFreshTail, maxTokens - usedTokens);

  // Sanitize fresh tail: drop orphaned tool_result messages whose tool_use
  // was trimmed by budget constraints, and ensure valid pairing
  let sanitized = sanitizeToolPairs(tailMessages);

  // ── v2 stub-and-store (Part XVIII §E) ──
  // After STUB_AFTER_TURNS turns, raw tool_result content gets replaced with
  // a stub. Combined with vault as long-term memory (§C), the agent doesn't
  // need raw results kept around. Without this, even with per-tool result
  // caps and lazy loading, context grows linearly with turn count over a
  // long session. With it, context stays roughly flat — old tool results
  // become stubs and the model uses the vault for findings that matter.
  //
  // NULL turn_number → treated as "very old" (pre-v2 messages) — they get
  // stubbed too. v2-persisted messages have turn_number set; the rare gap
  // is user messages (persisted by chat route) which are NULL but never
  // tool_result anyway, so stubOldToolResults skips them.
  sanitized = stubOldToolResults(sanitized, agentId);

  // Auto-load tools that appear in recent assistant tool_use blocks.
  // This handles the case where an agent previously loaded a tool but the
  // server restarted (in-memory session state was lost). Without this,
  // the agent would need to re-call load_tool_docs for tools it's already
  // been using in this conversation.
  try {
    const { markToolsLoaded } = await import('../tools/tool-docs.js');
    const seenToolNames = new Set<string>();
    for (const msg of sanitized) {
      if (msg.role !== 'assistant') continue;
      try {
        const parsed = JSON.parse(msg.content);
        if (Array.isArray(parsed)) {
          for (const block of parsed) {
            if (block?.type === 'tool_use' && typeof block.name === 'string') {
              seenToolNames.add(block.name);
            }
          }
        }
      } catch { /* not JSON, skip */ }
    }
    if (seenToolNames.size > 0) {
      markToolsLoaded(agentId, [...seenToolNames]);
    }
  } catch { /* best effort */ }

  for (const msg of sanitized) {
    const parsed = parseMessageContent(msg);

    if (msg.role === 'tool') {
      // Tool results go as user role with content blocks
      messages.push({ role: 'user', content: parsed as Anthropic.ContentBlockParam[] });
    } else if (msg.role === 'user' || msg.role === 'assistant') {
      // For assistant messages with thinking-mode reasoning_content, carry
      // it through as a sibling field so the model.ts dispatch can echo it
      // back to the provider on the next request. DeepSeek explicitly
      // requires this on tool-call follow-up turns; other providers
      // ignore the field harmlessly.
      const out: { role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[]; reasoningContent?: string } = {
        role: msg.role,
        content: parsed,
      };
      if (msg.role === 'assistant' && msg.reasoningContent) {
        out.reasoningContent = msg.reasoningContent;
      }
      messages.push(out as { role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] });
    }
    // Skip system messages in history
  }

  // ── Prune old image / document blocks from tool_result history ──
  // file_read on an image returns the image as a base64 content block
  // inside the tool_result. Each ~647KB PNG ≈ 250K tokens base64. After
  // 4 file_reads on slide PNGs, the fresh tail can exceed the model's
  // context window before any text is even considered (user reported
  // inputEstimate=777K with messageCount=3 — caused entirely by stacked
  // image blocks). Only the MOST RECENT image is needed for vision; older
  // ones can be replaced with a text stub. The agent can re-call
  // file_read on the path if it genuinely needs to re-examine.
  pruneOldImageBlocksInPlace(messages, /* maxKeepImages */ 1);

  // ── v2 only: per-tool-result text cap (Part V) ──
  // A 30K-token file_read becomes a ~3K stub. This is the per-call cap,
  // applied to fresh tail tool results. Older results (≥STUB_AFTER_TURNS
  // turns) were already replaced with much shorter stubs above by
  // stubOldToolResults — capLargeToolResultsInPlace mostly affects the
  // recent tail.
  capLargeToolResultsInPlace(messages);

  // Ensure messages start with user role (Anthropic API requirement).
  // Drop leading assistant messages and pure tool_result messages that
  // reference tool_use IDs no longer in context. Stop at the first
  // real user message.
  while (messages.length > 0) {
    const first = messages[0];
    if (first.role === 'assistant') {
      messages.shift();
      continue;
    }
    // Check if this user message is ONLY tool_result blocks (no text)
    if (first.role === 'user' && Array.isArray(first.content)) {
      const blocks = first.content as Array<{ type?: string }>;
      const allToolResults = blocks.length > 0 && blocks.every(b => b.type === 'tool_result');
      if (allToolResults) {
        messages.shift();
        continue;
      }
    }
    break;
  }

  // Ensure alternating roles
  let merged = mergeConsecutiveRoles(messages);

  // Self-heal: drop orphaned tool blocks so the agent can recover from a
  // broken conversation invariant without manual intervention. Both the
  // Anthropic and OpenAI-compatible APIs require that every tool_use in
  // an assistant message has a matching tool_result in a following user
  // message, and every tool_result references a tool_use id that appears
  // in a preceding assistant message. Violations cause provider errors
  // like MiniMax's "tool result's tool id(...) not found", which leaves
  // the agent stuck in a loop of failed calls.
  //
  // Causes include mid-history compaction dropping an assistant turn
  // but leaving the tool_result behind, stream accumulators capturing
  // a drifted id, or transient DB failures. We don't try to diagnose
  // which one — we just enforce the invariant before every call.
  const preSanitizeCount = merged.length;
  merged = sanitizeToolBlocks(merged, agentId);
  // Safety check: if sanitization dropped more than half the messages, something is wrong.
  // Log a critical warning so we can debug. Don't drop them — the provider error is better
  // than silently losing the conversation.
  if (merged.length < preSanitizeCount / 2 && preSanitizeCount > 4) {
    logger.error('sanitizeToolBlocks dropped over half the context — possible bug', {
      before: preSanitizeCount,
      after: merged.length,
      agentId,
    }, agentId);
  }

  // Final safety: strip any remaining tool_result blocks from the first message.
  // After merging and sanitization, a tool_result can still end up at position 0
  // if it got merged with a text message. Providers reject this.
  if (merged.length > 0 && merged[0].role === 'user' && Array.isArray(merged[0].content)) {
    const firstBlocks = merged[0].content as unknown as Array<Record<string, unknown>>;
    const filtered = firstBlocks.filter(b => b.type !== 'tool_result');
    if (filtered.length < firstBlocks.length) {
      logger.warn('Stripped tool_result blocks from first context message', {
        droppedCount: firstBlocks.length - filtered.length,
      }, agentId);
      if (filtered.length === 0) {
        merged.shift();
      } else {
        merged[0] = { ...merged[0], content: filtered as unknown as Anthropic.ContentBlockParam[] };
      }
    }
  }

  // Ensure conversation ends with a user message (Anthropic API requirement —
  // "does not support assistant message prefill")
  while (merged.length > 0 && merged[merged.length - 1].role === 'assistant') {
    merged.pop();
  }

  // Guard: if we have zero messages after all filtering, pull the last user message
  // directly from DB so the agent at least sees what it's supposed to respond to.
  //
  // CRITICAL: respect session_started_at. After a reset_session call, the
  // assembler is asked to build context for the post-reset turn. If we
  // recover a user message from BEFORE the reset boundary, the model
  // re-processes "Reset your session" (or any natural phrasing of it) and
  // calls reset_session again → loop. The earlier `NOT LIKE '%reset_session%'`
  // filter only caught the snake_case tool name; real users say "reset" or
  // "fresh start" or "wipe your context" — none of which match.
  //
  // Post-reset behavior: when session_started_at is set and no user message
  // exists after that boundary, return an empty messages array. The v2 loop's
  // empty-messages guard (loop.ts:459) will exit cleanly to idle. A generic
  // "Continue with your current task" fallback would conflict with FRESH_START's
  // "wait for the user's next message" instruction and trigger the agent to
  // spam-poll the tracker looking for work.
  if (merged.length === 0) {
    try {
      const db = getDb();
      const sessionRow = db.prepare(
        'SELECT session_started_at FROM agents WHERE id = ?'
      ).get(agentId) as { session_started_at: string | null } | undefined;
      const sessionBoundary = sessionRow?.session_started_at ?? null;

      const baseConditions = [
        "agent_id = ?",
        "role = 'user'",
        "content NOT LIKE '[System:%'",
        // Belt + suspenders: still skip messages that literally name the tool.
        "content NOT LIKE '%reset_session%'",
      ];
      const params: unknown[] = [agentId];
      if (sessionBoundary) {
        baseConditions.push('created_at >= ?');
        params.push(sessionBoundary);
      }
      const sql = `SELECT content FROM messages WHERE ${baseConditions.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT 1`;
      const lastUserMsg = db.prepare(sql).get(...params) as { content: string } | undefined;

      if (lastUserMsg) {
        logger.error('Context assembly produced 0 messages after filtering — recovering last user message', {
          preSanitizeCount,
          agentId,
        }, agentId);
        merged.push({ role: 'user', content: lastUserMsg.content });
      } else if (sessionBoundary) {
        // Fresh post-reset session with nothing to process — let the loop's
        // empty-messages guard idle the agent. No fallback message.
        logger.info('Context assembly: post-reset with no user message after boundary — returning empty for clean idle', {
          sessionBoundary,
          agentId,
        }, agentId);
      } else {
        // No session boundary set and no recoverable message — preserve
        // legacy fallback so the agent has something to respond to.
        logger.error('Context assembly produced 0 messages after filtering and no recoverable user message', {
          preSanitizeCount,
          agentId,
        }, agentId);
        merged.push({ role: 'user', content: 'Continue with your current task.' });
      }
    } catch {
      merged.push({ role: 'user', content: 'Continue with your current task.' });
    }
  }

  // If this is a new session, inject a brief context note into the first user message
  // so the agent understands the conversation was intentionally reset.
  // This only fires once — after the agent responds, there will be assistant messages
  // in the session and this won't trigger again.
  try {
    const db = getDb();
    const sessionRow = db.prepare('SELECT session_started_at FROM agents WHERE id = ?').get(agentId) as { session_started_at: string | null } | undefined;
    if (sessionRow?.session_started_at) {
      const assistantInSession = db.prepare(
        "SELECT COUNT(*) as cnt FROM messages WHERE agent_id = ? AND role = 'assistant' AND created_at >= ?"
      ).get(agentId, sessionRow.session_started_at) as { cnt: number };
      if (assistantInSession.cnt === 0 && merged.length > 0 && merged[merged.length - 1].role === 'user') {
        const lastMsg = merged[merged.length - 1];
        if (typeof lastMsg.content === 'string') {
          lastMsg.content = `[New Session] Your previous conversation history has been archived. You still have access to your long-term memory via vault_search. You DO NOT have the detailed conversation from before — only summaries. If the user references something specific from before, use vault_search to find it.\n\n${lastMsg.content}`;
        }
      }
    }
  } catch { /* session_started_at column may not exist yet */ }

  // If the user pressed Stop since the last turn, inject a stop marker into
  // the last user message telling the model to abandon its prior plan. The
  // flag is set by stopAgent() in runtime.ts and cleared here after we've
  // applied it. The marker exists only in the model's in-memory context —
  // it is never persisted to the messages table, so the dashboard chat feed
  // does not show it to the user.
  try {
    const db = getDb();
    const row = db.prepare('SELECT config FROM agents WHERE id = ?').get(agentId) as { config: string } | undefined;
    if (row?.config) {
      const config = JSON.parse(row.config) as Record<string, unknown>;
      // ── A2A preempt marker (v2.5.38) ──
      // When another agent's wake-intent A2A delivery preempted this
      // agent's mid-flight turn, the transport set a2aPreemptPending in
      // this agent's config. Inject a context note on the next assembly
      // explaining what happened, encouraging a response, warning about
      // possible orphan tool_use, and surfacing the recent preempt
      // count so the agent can self-throttle if pinged repeatedly.
      // Prepend to the LAST user message (the inbound A2A) so the
      // model reads the framing immediately before the message itself.
      if (config.a2aPreemptPending && typeof config.a2aPreemptPending === 'object') {
        const p = config.a2aPreemptPending as {
          fromName?: string;
          intent?: string;
          threadShort?: string;
          recentCount?: number;
        };
        const fromName = p.fromName ?? 'another agent';
        const intent = p.intent ?? 'message';
        const threadShort = p.threadShort ?? '';
        const recentCount = typeof p.recentCount === 'number' ? p.recentCount : 1;

        const stormHint = recentCount >= 3
          ? ` ${fromName} has interrupted you ${recentCount}x in the last 5 minutes — if this looks like ping-pong (you keep responding, they keep asking), KEEP YOUR REPLY EXTREMELY TERSE (one sentence max) so the back-and-forth burns out and you can return to the original work.`
          : '';

        const PREEMPT_MARKER = (
          `[Context note: ${fromName} interrupted your turn with a [A2A:${intent}] message on thread ${threadShort} — that's the message right below this note. ` +
          `Handle it now: respond via send_to_agent on the same thread (or take whatever action they're asking for). ` +
          `Your prior tool work was aborted mid-flight, so the most recent tool_use in your fresh tail may NOT have a matching tool_result yet — if you need that result to continue, re-call the tool. ` +
          `After dealing with this interruption, resume the work you were on before.${stormHint}]`
        );

        if (merged.length > 0 && merged[merged.length - 1].role === 'user') {
          const lastMsg = merged[merged.length - 1];
          if (typeof lastMsg.content === 'string') {
            lastMsg.content = `${PREEMPT_MARKER}\n\n${lastMsg.content}`;
          } else if (Array.isArray(lastMsg.content)) {
            lastMsg.content = [
              { type: 'text', text: PREEMPT_MARKER } as Anthropic.TextBlockParam,
              ...(lastMsg.content as Anthropic.ContentBlockParam[]),
            ];
          }
        }
        // Clear the pending flag so the marker fires exactly once.
        delete config.a2aPreemptPending;
        db.prepare("UPDATE agents SET config = ? WHERE id = ?").run(JSON.stringify(config), agentId);
      }

      if (config.stopMarkerPending === true) {
        // v2.5.35 — Wording fix. Pre-fix the marker said "Read the next
        // user message as a fresh request" — but the marker is PREPENDED
        // to that user message, not placed before a separate one. Models
        // (especially weaker ones) read "the next user message" as "wait
        // for the message that comes after this one to arrive" and just
        // sit idle, producing no response. Then the user re-sends the
        // same prompt, the flag has been cleared, no marker fires, and
        // the second send goes through normally — that's the "first
        // prompt after Stop gets ignored" symptom reported in v2.5.34
        // and earlier.
        const STOP_MARKER = '[Context note: the user just hit the Stop button on your previous turn. Your previous plan is CANCELLED. Do NOT continue the tool loop you were executing. Do NOT retry the last action with a different approach. Do NOT resume your prior work. The user\'s new request follows IMMEDIATELY BELOW — respond to that message as a fresh ask, not whatever you were doing before.]';
        if (merged.length > 0 && merged[merged.length - 1].role === 'user') {
          const lastMsg = merged[merged.length - 1];
          if (typeof lastMsg.content === 'string') {
            lastMsg.content = `${STOP_MARKER}\n\n${lastMsg.content}`;
          } else if (Array.isArray(lastMsg.content)) {
            // Content blocks (e.g. tool_result) — prepend a text block
            lastMsg.content = [
              { type: 'text', text: STOP_MARKER } as Anthropic.TextBlockParam,
              ...(lastMsg.content as Anthropic.ContentBlockParam[]),
            ];
          }
        }
        // Clear the flag so the marker fires exactly once.
        config.stopMarkerPending = false;
        db.prepare("UPDATE agents SET config = ? WHERE id = ?").run(JSON.stringify(config), agentId);
      }
    }
  } catch { /* config may not exist or be malformed */ }

  logger.info('Context assembled', {
    systemPromptTokens: estimateTokens(systemPrompt),
    summaryCount: summaries.length,
    freshTailCount: tailMessages.length,
    totalMessages: merged.length,
    estimatedTokens: usedTokens,
  }, agentId);

  return { systemPrompt, messages: merged };
}

// ── Helpers ──

function formatSummaryXml(summary: Summary): string {
  return `<summary id="${summary.id}" depth="${summary.depth}" kind="${summary.kind}" tokens="${summary.tokenCount}" earliest="${summary.earliestAt}" latest="${summary.latestAt}">
${summary.content}
</summary>`;
}

function budgetSummaries(summaries: Summary[], availableTokens: number): Summary[] {
  // Reserve at least 30% of available tokens for fresh tail
  const summaryBudget = Math.floor(availableTokens * 0.7);
  let usedTokens = 0;

  // Include from newest to oldest (reverse), since newest summaries are most relevant
  // But we want chronological order in output, so collect indices
  const included: Summary[] = [];

  // First pass: try to include all
  for (const summary of summaries) {
    if (usedTokens + summary.tokenCount <= summaryBudget) {
      included.push(summary);
      usedTokens += summary.tokenCount;
    }
  }

  // If all fit, return them all (already in chronological order)
  if (included.length === summaries.length) {
    return included;
  }

  // Otherwise, drop oldest first until we fit
  const reversed = [...summaries].reverse();
  const keptFromNewest: Summary[] = [];
  usedTokens = 0;

  for (const summary of reversed) {
    if (usedTokens + summary.tokenCount <= summaryBudget) {
      keptFromNewest.push(summary);
      usedTokens += summary.tokenCount;
    }
  }

  // Return in chronological order
  return keptFromNewest.reverse();
}

/**
 * Walk the assembled messages newest-first and replace image / document
 * blocks beyond the keep limit with text placeholders. The model only
 * needs to "see" the most recent image; older ones blow context budget
 * for no semantic gain. Mutates messages in place.
 *
 * Specifically prunes:
 *   - tool_result blocks whose content array contains image / document blocks
 *   - top-level image / document blocks (rare, but possible)
 *
 * Keeps:
 *   - The MOST RECENT N images (default 1)
 *   - All text blocks
 *   - All tool_use blocks (those are tiny)
 */
/**
 * v2 — Detect "session start" turns: turns where scaffolding (briefing,
 * vault, active tasks, continuity brief) should be re-injected.
 *
 * Definition: an agent is at session-start if either:
 *   1. session_started_at is set AND no assistant message exists since then
 *      (true first turn after a session reset / new session), OR
 *   2. there are zero assistant messages for the agent at all (brand new agent).
 *
 * This matches the existing "── New Session ──" detection at the bottom
 * of assembleContext for v1, just lifted into a reusable helper.
 *
 * Mid-session turns return false → no scaffolding cost.
 */
/**
 * Stub-and-store (Part XVIII §E). Replace tool_result content older than
 * V2_STUB_AFTER_TURNS turns with a short stub so context stays roughly
 * flat as the agent works.
 *
 * Operates on Message[] (the DB-shaped objects), not on the
 * Anthropic-format ContentBlockParam arrays — turn_number is only available
 * on the DB row.
 *
 * NULL turn_number (v1-era messages, user messages from chat route) is
 * treated as "very old" and stubbed if it's a tool_result. In practice
 * user messages are never tool_result, so this only affects pre-v2 tool
 * results — the intended behavior per spec.
 */
export function stubOldToolResults(messages: Message[], agentId: string): Message[] {
  const db = getDb();
  // currentTurn = highest turn_number ever persisted for this agent + 1.
  // Same logic v2/loop.ts uses to compute its own turn number.
  const row = db
    .prepare('SELECT MAX(turn_number) AS max_turn FROM messages WHERE agent_id = ?')
    .get(agentId) as { max_turn: number | null } | undefined;
  const currentTurn = (row?.max_turn ?? 0) + 1;

  let stubbedCount = 0;

  const stubbed = messages.map((msg) => {
    if (msg.role !== 'tool') return msg;
    // turn_number can be NULL for very old / non-v2-written messages.
    // Treat NULL as -infinity so it's always older than the threshold.
    const msgTurn = msg.turnNumber ?? -Infinity;
    const turnAge = currentTurn - msgTurn;
    if (turnAge < V2_STUB_AFTER_TURNS) return msg;

    let blocks: unknown;
    try {
      blocks = JSON.parse(msg.content);
    } catch {
      return msg;
    }
    if (!Array.isArray(blocks)) return msg;

    let messageChanged = false;
    const newBlocks = blocks.map((b: { type?: string; content?: unknown; tool_use_id?: string }) => {
      if (b.type !== 'tool_result') return b;
      const contentStr = typeof b.content === 'string' ? b.content : '';
      const len = contentStr.length;
      const turnLabel = msg.turnNumber !== null && msg.turnNumber !== undefined ? `turn ${msg.turnNumber}` : 'pre-v2 history';
      messageChanged = true;
      return {
        ...b,
        content: `[Tool result from ${turnLabel}, ${len} chars, cleared from context. Re-call the tool or check vault for findings.]`,
      };
    });

    if (!messageChanged) return msg;
    stubbedCount++;
    return { ...msg, content: JSON.stringify(newBlocks) };
  });

  if (stubbedCount > 0) {
    logger.debug('v2 stubOldToolResults: stubbed old tool results', {
      agentId,
      stubbedCount,
      currentTurn,
      stubAfterTurns: V2_STUB_AFTER_TURNS,
    }, agentId);
  }

  return stubbed;
}

function isV2SessionStart(agentId: string): boolean {
  try {
    const db = getDb();
    const sessionRow = db.prepare(
      'SELECT session_started_at FROM agents WHERE id = ?',
    ).get(agentId) as { session_started_at: string | null } | undefined;
    const sessionStarted = sessionRow?.session_started_at ?? null;
    let cnt: number;
    if (sessionStarted) {
      cnt = (db.prepare(
        "SELECT COUNT(*) as cnt FROM messages WHERE agent_id = ? AND role = 'assistant' AND created_at >= ?",
      ).get(agentId, sessionStarted) as { cnt: number }).cnt;
    } else {
      cnt = (db.prepare(
        "SELECT COUNT(*) as cnt FROM messages WHERE agent_id = ? AND role = 'assistant'",
      ).get(agentId) as { cnt: number }).cnt;
    }
    return cnt === 0;
  } catch {
    // If detection fails, default to NOT-session-start so we don't burn
    // tokens on scaffolding mid-conversation. Better to undershoot scaffolding
    // than overshoot.
    return false;
  }
}

/**
 * v2 — Cap the text content of tool_result blocks at V2_MAX_TOOL_RESULT_TOKENS.
 * Mutates messages in place. Each oversized result is truncated with a stub
 * that tells the agent how to retrieve more.
 *
 * Per Part V — without this, a single file_read of a 50K-token file dominates
 * the context budget and triggers the 90% WARN within a few turns.
 */
/**
 * Pre-budget cap for raw tool messages (content is still a JSON string at
 * this point). Walks any tool-role message, parses its tool_result blocks,
 * truncates each block's text content to V2_MAX_TOOL_RESULT_TOKENS, and
 * re-serializes. Mirrors capLargeToolResultsInPlace but operates BEFORE
 * budgetFreshTail so the budget sees realistic token counts.
 *
 * Without this, a single oversized tool_result could consume the entire
 * fresh-tail budget and force older messages — including the user's
 * question — out of context.
 */
function capLargeToolResultStrings(messages: Message[]): Message[] {
  return messages.map((msg) => {
    if (msg.role !== 'tool') return msg;
    let parsed: unknown;
    try {
      parsed = JSON.parse(msg.content);
    } catch {
      return msg;
    }
    if (!Array.isArray(parsed)) return msg;

    let mutated = false;
    const newBlocks = parsed.map((block: unknown) => {
      const blk = block as Record<string, unknown>;
      if (blk.type !== 'tool_result') return block;
      const c = blk.content;
      if (typeof c !== 'string') return block;
      const tokens = estimateTokens(c);
      if (tokens <= V2_MAX_TOOL_RESULT_TOKENS) return block;
      const keepChars = Math.max(
        500,
        Math.floor(c.length * (V2_MAX_TOOL_RESULT_TOKENS / tokens)),
      );
      const truncated =
        c.slice(0, keepChars) +
        `\n\n[... ${tokens - V2_MAX_TOOL_RESULT_TOKENS} tokens truncated. Call the same tool again with narrower arguments (e.g. file_read with offset/limit) to see more.]`;
      mutated = true;
      return { ...blk, content: truncated };
    });
    if (!mutated) return msg;
    return { ...msg, content: JSON.stringify(newBlocks), tokenCount: null };
  });
}

function capLargeToolResultsInPlace(
  messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }>,
): void {
  let cappedCount = 0;
  let tokensSaved = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (typeof msg.content === 'string') continue;
    if (!Array.isArray(msg.content)) continue;

    const newContent = msg.content.map((block) => {
      const blk = block as unknown as Record<string, unknown>;
      if (blk.type !== 'tool_result') return block;

      // tool_result.content can be either a string or an array of content blocks
      // (e.g., text + image when file_read returns an image). We only cap the
      // string variant — image/document blocks are handled by pruneOldImageBlocksInPlace.
      const content = blk.content;
      if (typeof content !== 'string') return block;

      const tokens = estimateTokens(content);
      if (tokens <= V2_MAX_TOOL_RESULT_TOKENS) return block;

      const keepChars = Math.max(
        500,
        Math.floor(content.length * (V2_MAX_TOOL_RESULT_TOKENS / tokens)),
      );
      const truncated =
        content.slice(0, keepChars) +
        `\n\n[... ${tokens - V2_MAX_TOOL_RESULT_TOKENS} tokens truncated. Call the same tool again with narrower arguments (e.g. file_read with offset/limit, or grep with a more specific pattern) to see more.]`;

      cappedCount++;
      tokensSaved += tokens - estimateTokens(truncated);
      return { ...blk, content: truncated } as unknown as Anthropic.ContentBlockParam;
    });

    messages[i] = { ...msg, content: newContent };
  }

  if (cappedCount > 0) {
    logger.debug('v2 capLargeToolResultsInPlace: capped tool results', {
      cappedCount,
      tokensSaved,
    });
  }
}

function pruneOldImageBlocksInPlace(
  messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }>,
  maxKeepImages: number,
): void {
  let imagesKept = 0;
  let prunedCount = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (typeof msg.content === 'string') continue;
    if (!Array.isArray(msg.content)) continue;

    const newContent: Anthropic.ContentBlockParam[] = msg.content.map(block => {
      const blk = block as unknown as Record<string, unknown>;

      // tool_result blocks: walk their nested content array
      if (blk.type === 'tool_result' && Array.isArray(blk.content)) {
        const nestedContent = blk.content as Array<Record<string, unknown>>;
        const newNested = nestedContent.map(nested => {
          if (nested.type === 'image') {
            if (imagesKept < maxKeepImages) {
              imagesKept++;
              return nested;
            }
            prunedCount++;
            return { type: 'text', text: '[image previously loaded — call file_read again on the same path if you need to re-examine it]' };
          }
          if (nested.type === 'document') {
            prunedCount++;
            return { type: 'text', text: '[document previously loaded — call file_read again if you need to re-examine it]' };
          }
          return nested;
        });
        return { ...blk, content: newNested } as unknown as Anthropic.ContentBlockParam;
      }

      // Top-level image (e.g., user attachment) — same rules.
      if (blk.type === 'image') {
        if (imagesKept < maxKeepImages) {
          imagesKept++;
          return block;
        }
        prunedCount++;
        return { type: 'text', text: '[image previously loaded]' } as Anthropic.ContentBlockParam;
      }

      if (blk.type === 'document') {
        prunedCount++;
        return { type: 'text', text: '[document previously loaded]' } as Anthropic.ContentBlockParam;
      }

      return block;
    });

    messages[i] = { ...msg, content: newContent };
  }

  if (prunedCount > 0) {
    logger.debug('Pruned old image/document blocks from context', { prunedCount, imagesKept });
  }
}

function budgetFreshTail(messages: Message[], availableTokens: number): Message[] {
  // Group messages into atomic units: tool_use + tool_result pairs must stay together.
  // A "group" is either a standalone message or an [assistant(tool_use), tool(tool_result)] pair.
  interface Group {
    messages: Message[];
    tokens: number;
  }

  const groups: Group[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    const tokens = msg.tokenCount ?? estimateTokens(msg.content);

    // Check if this assistant message has tool_use and is followed by a tool message
    let hasToolUse = false;
    try {
      const parsed = JSON.parse(msg.content);
      if (Array.isArray(parsed)) {
        hasToolUse = parsed.some((b: { type?: string }) => b.type === 'tool_use');
      }
    } catch {}

    if (hasToolUse && msg.role === 'assistant' && i + 1 < messages.length && messages[i + 1].role === 'tool') {
      const nextMsg = messages[i + 1];
      const nextTokens = nextMsg.tokenCount ?? estimateTokens(nextMsg.content);
      groups.push({ messages: [msg, nextMsg], tokens: tokens + nextTokens });
      i += 2;
    } else {
      groups.push({ messages: [msg], tokens });
      i++;
    }
  }

  // Work backwards, include groups that fit the budget.
  // ALWAYS include at least the most recent group so the agent can see
  // what it's supposed to respond to, even if it exceeds the budget.
  let usedTokens = 0;
  const includedGroups: Group[] = [];

  for (let g = groups.length - 1; g >= 0; g--) {
    if (usedTokens + groups[g].tokens > availableTokens && includedGroups.length > 0) {
      break;
    }
    includedGroups.push(groups[g]);
    usedTokens += groups[g].tokens;
  }

  // Safety: if nothing was included (all groups exceed budget), include the last one anyway.
  // An over-budget context is better than no context at all.
  if (includedGroups.length === 0 && groups.length > 0) {
    includedGroups.push(groups[groups.length - 1]);
    logger.warn('budgetFreshTail: all groups exceed budget, forcing last group inclusion', {
      groupCount: groups.length,
      lastGroupTokens: groups[groups.length - 1].tokens,
      availableTokens,
    });
  }

  // Flatten and return in chronological order
  return includedGroups.reverse().flatMap(g => g.messages);
}

/**
 * Ensure tool_use / tool_result pairs are always complete.
 * Every tool_use in an assistant message must have a matching tool_result in the
 * immediately following user/tool message, and vice versa.
 */
function sanitizeToolPairs(messages: Message[]): Message[] {
  // Build list with parsed tool IDs for each message
  interface Annotated {
    msg: Message;
    toolUseIds: string[];   // IDs from tool_use blocks (assistant messages)
    toolResultIds: string[]; // IDs from tool_result blocks (tool messages)
  }

  const annotated: Annotated[] = messages.map((msg) => {
    const toolUseIds: string[] = [];
    const toolResultIds: string[] = [];

    try {
      const parsed = JSON.parse(msg.content);
      if (Array.isArray(parsed)) {
        for (const block of parsed) {
          if (block.type === 'tool_use' && block.id) {
            toolUseIds.push(block.id);
          }
          if (block.type === 'tool_result' && block.tool_use_id) {
            toolResultIds.push(block.tool_use_id);
          }
        }
      }
    } catch {
      // Plain text — no tool blocks
    }

    return { msg, toolUseIds, toolResultIds };
  });

  // Iterate and keep only valid pairs.
  // An assistant message with tool_use must be immediately followed by a tool message
  // with matching tool_result IDs. If either is missing, drop BOTH.
  const keep = new Array<boolean>(annotated.length).fill(true);

  for (let i = 0; i < annotated.length; i++) {
    const entry = annotated[i];

    if (entry.toolUseIds.length > 0) {
      // This is an assistant message with tool_use. Check the next message.
      const next = i + 1 < annotated.length ? annotated[i + 1] : null;
      if (!next || next.msg.role !== 'tool') {
        // No tool_result follows — drop this assistant message
        keep[i] = false;
        continue;
      }

      // Check that every tool_use ID has a matching tool_result
      const resultIdSet = new Set(next.toolResultIds);
      const allMatched = entry.toolUseIds.every((id) => resultIdSet.has(id));
      if (!allMatched) {
        // Mismatch — drop both
        keep[i] = false;
        keep[i + 1] = false;
      }
    }

    if (entry.toolResultIds.length > 0 && entry.msg.role === 'tool') {
      // This is a tool_result message. Check the previous message.
      const prev = i > 0 ? annotated[i - 1] : null;
      if (!prev || prev.toolUseIds.length === 0) {
        // No preceding tool_use — drop this tool_result
        keep[i] = false;
        continue;
      }

      // Check that every tool_result ID has a matching tool_use
      const useIdSet = new Set(prev.toolUseIds);
      const allMatched = entry.toolResultIds.every((id) => useIdSet.has(id));
      if (!allMatched) {
        keep[i] = false;
        keep[i - 1] = false;
      }
    }
  }

  const result = annotated.filter((_, i) => keep[i]).map((a) => a.msg);

  const dropped = annotated.length - result.length;
  if (dropped > 0) {
    const droppedDetails = annotated
      .map((a, i) => keep[i] ? null : `[${i}] role=${a.msg.role} useIds=${a.toolUseIds.join(',')} resultIds=${a.toolResultIds.join(',')}`)
      .filter(Boolean);
    logger.warn(`Dropped ${dropped} messages with broken tool_use/tool_result pairs from context`, {
      details: droppedDetails.slice(0, 10),
    });
  }

  return result;
}

function parseMessageContent(
  msg: Message,
): string | Anthropic.ContentBlockParam[] {
  try {
    const parsed = JSON.parse(msg.content);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return msg.content;
  } catch {
    return msg.content;
  }
}

/**
 * Drop tool blocks that break the conversation invariant so the next
 * provider call does not fail with a "tool id not found" error.
 *
 * The invariant every chat API enforces:
 *   - Every `tool_use` block on an assistant message must have a matching
 *     `tool_result` block in a following user message (same id).
 *   - Every `tool_result` block on a user message must reference a
 *     `tool_use_id` that appears on a preceding assistant message.
 *
 * This function does two passes:
 *   1. Collect the set of tool_use ids that exist in assistant messages
 *      and the set of tool_result ids that exist in user messages.
 *   2. Filter each message's content blocks:
 *      - On assistant messages, drop tool_use blocks whose id has no
 *        matching tool_result anywhere in the history.
 *      - On user messages, drop tool_result blocks whose tool_use_id
 *        has no matching tool_use.
 *      - Text blocks are always kept.
 *   3. Any message that becomes empty after filtering is dropped
 *      entirely.
 *
 * The function is non-destructive — it returns a sanitized copy and
 * does not touch the messages table. The DB still holds the orphaned
 * rows so history stays intact; the invariant is only enforced on the
 * in-memory list that goes to the provider.
 */
function sanitizeToolBlocks(
  messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }>,
  agentId: string,
): Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }> {
  // Build POSITIONAL pairs: a tool_use is valid only if the NEXT message
  // (which must be a user message) contains a matching tool_result, and
  // a tool_result is valid only if the PRECEDING message (which must be
  // an assistant message) contains a matching tool_use.
  const validToolUseIds = new Set<string>();
  const validToolResultIds = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!Array.isArray(msg.content)) continue;
    const blocks = msg.content as unknown as Array<Record<string, unknown>>;

    if (msg.role === 'assistant') {
      // Collect tool_use IDs from this assistant message
      const useIds = blocks.filter(b => b.type === 'tool_use' && typeof b.id === 'string').map(b => b.id as string);
      if (useIds.length === 0) continue;

      // Check if the NEXT message is a user message with matching tool_results
      const next = i + 1 < messages.length ? messages[i + 1] : null;
      if (next && next.role === 'user' && Array.isArray(next.content)) {
        const nextBlocks = next.content as unknown as Array<Record<string, unknown>>;
        const resultIds = new Set(nextBlocks.filter(b => b.type === 'tool_result' && typeof b.tool_use_id === 'string').map(b => b.tool_use_id as string));
        for (const uid of useIds) {
          if (resultIds.has(uid)) {
            validToolUseIds.add(uid);
            validToolResultIds.add(uid);
          }
        }
      }
    }
  }

  // Pass 2: filter blocks that don't have a matching partner
  let droppedToolUse = 0;
  let droppedToolResult = 0;
  let droppedMessages = 0;
  const sanitized: typeof messages = [];

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) {
      sanitized.push(msg);
      continue;
    }
    const blocks = msg.content as unknown as Array<Record<string, unknown>>;

    const kept = blocks.filter(b => {
      if (msg.role === 'assistant' && b.type === 'tool_use') {
        if (typeof b.id === 'string' && validToolResultIds.has(b.id)) return true;
        droppedToolUse++;
        return false;
      }
      if (msg.role === 'user' && b.type === 'tool_result') {
        if (typeof b.tool_use_id === 'string' && validToolUseIds.has(b.tool_use_id)) return true;
        droppedToolResult++;
        return false;
      }
      return true; // text blocks and anything else pass through
    });

    if (kept.length === 0) {
      droppedMessages++;
      continue;
    }
    sanitized.push({ ...msg, content: kept as unknown as Anthropic.ContentBlockParam[] });
  }

  if (droppedToolUse > 0 || droppedToolResult > 0 || droppedMessages > 0) {
    logger.warn('Sanitized orphaned tool blocks from context', {
      droppedToolUse,
      droppedToolResult,
      droppedMessages,
      validToolUseIds: validToolUseIds.size,
      validToolResultIds: validToolResultIds.size,
    }, agentId);
  }

  return sanitized;
}

function mergeConsecutiveRoles(
  messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }>,
): Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }> {
  const merged: typeof messages = [];

  for (const msg of messages) {
    if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
      const prev = merged[merged.length - 1];
      if (typeof prev.content === 'string' && typeof msg.content === 'string') {
        prev.content = prev.content + '\n\n' + msg.content;
      } else {
        const prevArr = typeof prev.content === 'string'
          ? [{ type: 'text' as const, text: prev.content }]
          : prev.content;
        const msgArr = typeof msg.content === 'string'
          ? [{ type: 'text' as const, text: msg.content }]
          : msg.content;
        // Deduplicate tool_result blocks by tool_use_id
        const combined = [...prevArr, ...msgArr];
        const seenToolResultIds = new Set<string>();
        const deduped = combined.filter((block) => {
          const b = block as unknown as Record<string, unknown>;
          if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
            if (seenToolResultIds.has(b.tool_use_id)) return false;
            seenToolResultIds.add(b.tool_use_id);
          }
          return true;
        });
        prev.content = deduped;
      }
    } else {
      merged.push({ ...msg });
    }
  }

  return merged;
}
