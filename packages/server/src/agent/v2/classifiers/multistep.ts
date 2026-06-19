// ════════════════════════════════════════
// Phase v2.3.3 — multi-step detection
//
// Engine-side detection of "this prompt is going to take more than one
// turn." When confident, the loop calls createProject directly so the
// tracker entry exists before the agent starts working — same lesson
// as the technique injection: take the decision out of the LLM's hands
// because system-prompt instructions don't reliably get followed.
//
// Two-stage:
//   1. Heuristic prefilter (free, deterministic): action-verb count,
//      coordinating conjunctions, distinct deliverables. Decides
//      confidently in most cases — only ambiguous prompts go to (2).
//   2. Local-LLM classifier (optional, ~500ms): asks a small Ollama
//      model "is this multi-step? if so, give a 3-5 word name." Used
//      only when the heuristic is uncertain. Falls back to heuristic-
//      only if no model is configured.
//
// Config lives in the `config` table under key 'multistep_config' to
// match the embedding_config pattern.
// ════════════════════════════════════════

import { getDb } from '../../../db/connection.js';
import { createLogger } from '../../../logger.js';

const logger = createLogger('classifier:multistep');

// ── Config ──

export interface MultistepConfig {
  enabled: boolean;
  /** Ollama model name (e.g. "qwen2.5:7b"). null → heuristic-only. */
  model: string | null;
  baseUrl: string;
  timeoutMs: number;
}

export function getMultistepConfig(): MultistepConfig {
  const db = getDb();
  const row = db.prepare("SELECT value FROM config WHERE key = 'multistep_config'").get() as { value: string } | undefined;

  if (row) {
    try {
      const parsed = JSON.parse(row.value);
      return {
        enabled: parsed.enabled ?? true,
        model: parsed.model ?? null,
        baseUrl: parsed.baseUrl ?? 'http://localhost:11434',
        timeoutMs: parsed.timeoutMs ?? 5000,
      };
    } catch { /* fall through to defaults */ }
  }

  return {
    enabled: true,
    model: null,
    baseUrl: 'http://localhost:11434',
    timeoutMs: 5000,
  };
}

export function setMultistepConfig(patch: Partial<MultistepConfig>): void {
  const current = getMultistepConfig();
  const updated = { ...current, ...patch };
  const db = getDb();
  db.prepare(`
    INSERT INTO config (key, value, updated_at) VALUES ('multistep_config', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `).run(JSON.stringify(updated), JSON.stringify(updated));
}

// ── Heuristic ──

export type HeuristicDecision = 'definitely_single' | 'definitely_multi' | 'ambiguous';

export interface MultistepHeuristic {
  decision: HeuristicDecision;
  score: number;
  signals: {
    actionVerbs: number;
    conjunctions: number;
    /** Sentence/clause boundaries between imperatives — coordination, like "and". */
    clauseBoundaries: number;
    deliverables: number;
    chars: number;
  };
}

// Action verbs that suggest the agent has to *do* something, not just
// answer a question. Tense-folded; we lowercase the input.
const ACTION_VERBS = new Set([
  'pull', 'fetch', 'get', 'grab', 'download', 'retrieve',
  'send', 'email', 'message', 'text', 'imessage', 'post', 'publish',
  'create', 'make', 'build', 'generate', 'draft', 'write', 'compose',
  'summarize', 'summarise', 'compile', 'aggregate', 'gather',
  'find', 'search', 'look', 'lookup', 'investigate', 'check',
  'update', 'edit', 'change', 'modify', 'fix', 'patch',
  'delete', 'remove', 'clear', 'archive',
  'schedule', 'plan', 'organize', 'organise',
  'analyze', 'analyse', 'review', 'audit', 'evaluate',
  'remind', 'notify', 'alert',
  'export', 'import', 'backup', 'restore',
  'attach', 'upload', 'save',
]);

const CONJUNCTIONS = new Set(['and', 'then', 'also', 'plus', 'after', 'next']);

// v2.5.46 — words that, when they immediately precede a candidate "verb",
// strongly suggest the candidate is actually being used as a noun. "Email"
// is an action verb in "email the team" but a noun in "any new emails".
// "Message", "text", "post", "list", "report" have the same ambiguity.
// Without this guard the heuristic falsely fires multistep for short
// lookup questions ("do you have any new emails today?") which then
// auto-creates a tracker project and triggers the close-out loop.
const NOUNIFYING_PREDECESSORS = new Set([
  'any', 'the', 'a', 'an',
  'my', 'your', 'his', 'her', 'its', 'our', 'their',
  'some', 'this', 'that', 'these', 'those',
  'few', 'several', 'many', 'all', 'no', 'every',
  'each', 'another', 'such',
  'new', 'old', 'recent', 'latest', 'pending', 'unread',
]);

/**
 * Try the token against ACTION_VERBS in a few morphological forms.
 * Catches "pulling" / "pulled" / "summarizing" / "summarised" without
 * requiring every conjugation in the set.
 *
 * `prevToken` is the immediately preceding word in the input (or null at
 * the start). When `prevToken` is a determiner / quantifier / adjective
 * that almost always introduces a noun phrase, we treat the candidate as
 * a noun and refuse to count it as an action verb.
 */
function matchesActionVerb(token: string, prevToken: string | null): boolean {
  const candidateIsVerbLike =
    ACTION_VERBS.has(token) ||
    (token.endsWith('s') && ACTION_VERBS.has(token.slice(0, -1))) ||
    (token.endsWith('ed') && (ACTION_VERBS.has(token.slice(0, -2)) || ACTION_VERBS.has(token.slice(0, -2) + 'e'))) ||
    (token.endsWith('ing') && (ACTION_VERBS.has(token.slice(0, -3)) || ACTION_VERBS.has(token.slice(0, -3) + 'e')));

  if (!candidateIsVerbLike) return false;

  // Determiner / adjective directly before this token → noun usage.
  if (prevToken && NOUNIFYING_PREDECESSORS.has(prevToken)) return false;

  return true;
}

// v2.5.46 — Question detection. Prompts that ask the agent for information
// (rather than directing it to do work) are almost always single-step
// lookups. We use this as a tiebreaker for ambiguous heuristic cases and
// as the fallback bias when no local-LLM classifier is configured.
const INTERROGATIVE_LEAD =
  /^\s*(do|does|did|is|are|am|was|were|will|would|can|could|should|shall|may|might|have|has|had|what|whats|where|wheres|when|whens|why|whys|who|whos|whom|whose|which|how|hows)\b/i;

export function looksLikeQuestion(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.endsWith('?')) return true;
  if (INTERROGATIVE_LEAD.test(trimmed)) return true;
  return false;
}

// Deliverable indicators: words/phrases that signal a discrete output
// the agent has to produce. Catches prompts that imply outputs without
// explicit conjunctions ("a summary of X for Y").
const DELIVERABLE_HINTS = [
  /\bsummary\b/, /\breport\b/, /\bdoc(?:ument)?\b/, /\bemail\b/,
  /\bmessage\b/, /\blist\b/, /\boverview\b/, /\bbreakdown\b/,
  /\bdigest\b/, /\bbrief\b/,
];

export function multistepHeuristic(query: string): MultistepHeuristic {
  const lower = query.toLowerCase();
  const tokens = lower.replace(/[^a-z0-9\s'-]/g, ' ').split(/\s+/).filter(Boolean);

  let actionVerbs = 0;
  let conjunctions = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const prev = i > 0 ? tokens[i - 1] : null;
    if (matchesActionVerb(t, prev)) actionVerbs++;
    if (CONJUNCTIONS.has(t)) conjunctions++;
  }

  let deliverables = 0;
  for (const re of DELIVERABLE_HINTS) {
    if (re.test(lower)) deliverables++;
  }

  // Sentence/clause boundaries act as coordination: "Make X. Generate Y." is
  // the same "do two things" signal as "Make X and generate Y." The tokenizer
  // above strips punctuation, so we count boundaries on the raw lowercased
  // text. Only count a terminator when real word content follows it — so a
  // trailing "." and tokens like "report.txt" / "3.5" (no following space)
  // don't register. This is what catches the "Build a page. Generate an
  // image." class the conjunction-only check used to miss.
  const clauseBoundaries = (lower.match(/[.!?;\n]+\s+(?=[a-z0-9])/g) ?? []).length;
  // Coordination = explicit conjunctions OR clause boundaries between work.
  const coordination = conjunctions + clauseBoundaries;

  const chars = query.length;
  const isQuestion = looksLikeQuestion(query);

  // Scoring: weight action verbs heaviest. Two distinct action verbs
  // joined by coordination is the canonical multi-step signal.
  const score = actionVerbs * 1.0 + Math.min(coordination, 3) * 0.5 + deliverables * 0.6;

  let decision: HeuristicDecision;
  if (chars < 20 && actionVerbs <= 1) {
    decision = 'definitely_single';
  } else if (actionVerbs >= 3 || (actionVerbs >= 2 && coordination >= 1)) {
    // Genuinely multi-step even if phrased as a question
    // ("can you find X, summarize it, and email it?") or split across
    // sentences ("Build the page. Generate the background image.").
    decision = 'definitely_multi';
  } else if (isQuestion && actionVerbs <= 1 && conjunctions === 0) {
    // Short/medium question with at most one action verb and no
    // conjunction — almost certainly a lookup, not a project.
    decision = 'definitely_single';
  } else if (actionVerbs <= 1 && conjunctions === 0) {
    // v2.5.46 — Single imperative: "Send an email saying hi", "Schedule a
    // meeting for Tuesday", "Delete the test files". One action, no
    // "and/then" joining additional work — it's one task, not a project.
    // Without this, the fallback path was auto-creating trackers for simple
    // commands and the close-out gate then looped the agent (observed
    // 2026-05-19: "Send an email" → 3 replies for one voice prompt).
    decision = 'definitely_single';
  } else if (actionVerbs === 0 && deliverables === 0) {
    decision = 'definitely_single';
  } else {
    decision = 'ambiguous';
  }

  return {
    decision,
    score,
    signals: { actionVerbs, conjunctions, clauseBoundaries, deliverables, chars },
  };
}

// ── Local-LLM classifier ──

export interface MultistepLLMResult {
  multistep: boolean;
  name: string | null;
}

/** Tolerant JSON extraction — cloud models may wrap the object in prose or
 *  ```json fences, unlike Ollama's forced `format: 'json'`. Pull the first
 *  balanced-looking {...} and parse that. */
function parseClassifierJson(text: string): { multistep?: unknown; name?: unknown } | null {
  if (!text) return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1)) as { multistep?: unknown; name?: unknown };
  } catch {
    return null;
  }
}

/**
 * Classify an ambiguous prompt using the configured SYSTEM model (the
 * "system" router tier — Settings → Router). Routed through the general
 * callModel path so the System model can be cloud OR local, not just Ollama.
 * Returns null on any failure or when no System model is configured — the
 * caller then falls back to heuristic-only behavior.
 */
export async function multistepLLMClassify(
  query: string,
  agentId: string,
  timeoutMs = 5000,
): Promise<MultistepLLMResult | null> {
  if (!agentId) return null;
  const { getSystemModel } = await import('../../../router/selector.js');
  const systemModel = getSystemModel();
  if (!systemModel) return null;

  const prompt =
    'You are a classifier. Decide if the user task below is multi-step (more than 2 distinct actions or deliverables) or single-step.\n' +
    'Reply with JSON only, no prose:\n' +
    '{"multistep": true|false, "name": "3-5 word project name or null"}\n\n' +
    `Task: ${query}`;

  try {
    const { callModel } = await import('../../model.js');
    const result = await callModel({
      agentId,
      modelId: systemModel,
      systemPrompt: '',
      messages: [{ role: 'user', content: prompt }],
      tools: false,
      abortSignal: AbortSignal.timeout(timeoutMs),
    });

    const parsed = parseClassifierJson(result.content);
    if (!parsed) {
      logger.warn('Multistep classifier: system model returned unparseable output', { model: systemModel });
      return null;
    }

    const multistep = parsed.multistep === true;
    const name = typeof parsed.name === 'string' && parsed.name.trim().length > 0
      ? parsed.name.trim().slice(0, 80)
      : null;

    return { multistep, name };
  } catch (err) {
    logger.warn('Multistep classifier (system model) failed (non-fatal — falling back to heuristic)', {
      error: err instanceof Error ? err.message : String(err),
      model: systemModel,
    });
    return null;
  }
}

// Engine-auto-created projects carry this prefix in their description.
// Used by:
//  - The tracker dup-guard, to detect "the engine just opened this for
//    you on this same user turn" and steer the agent toward
//    tracker_edit_task rather than spinning a parallel project.
//  - The post-create rename handoff, which fires an A2A-style message
//    at the PM agent asking it to rename the project and first task
//    using its local model (gemma4:31b). Naming runs async on the PM's
//    turn rather than on the user-facing agent's turn — keeps the chat
//    reply latency clean.
export const ENGINE_AUTO_MARKER = '[engine:multistep] ';

// ── User explicitly requesting project creation ──
//
// v2.5.46 — Audit found that the multistep auto-create fires on prompts
// like "Start a project called X with step 1 and step 2." The classifier
// sees 3+ action verbs and creates an umbrella task. Then the agent
// (correctly) builds its OWN multi-step project structure. The
// auto-created umbrella becomes a redundant dangler that never gets
// closed — triggering the close-out gate next turn for no good reason.
//
// Fix: when the user explicitly asks the agent to create a tracker
// entity ("start a project", "create a task", "add to the tracker"),
// skip auto-create and let the agent do it themselves. The new v2.5.46
// reflex bullet defaults agents toward tracker_create_project for any
// non-trivial work, so we can trust the agent to follow through.

// Engine-generated user-role messages — never trigger auto-create on these.
// Discovered the hard way: the PM rename-request handoff was being
// re-classified as a multi-step user prompt on PM's turn, causing PM to
// auto-create a second project where the title was the rename request
// text itself. Same shape of bug for any engine-injected "user" message
// that happens to contain action verbs (A2A pokes, scheduler payloads,
// assignment notifications, system source tags).
const ENGINE_MESSAGE_PREFIXES: readonly string[] = [
  '[ENGINE RENAME REQUEST]',
  '[PLATFORM MIGRATION]',
  '[TECHNIQUE IMPORT]',
  '[SOURCE: ',
  '[A2A:',
  '[scheduler:',
  '[System:',
  '[SYSTEM ',
];

export function looksLikeEngineMessage(query: string): boolean {
  const trimmed = query.trimStart();
  return ENGINE_MESSAGE_PREFIXES.some(prefix => trimmed.startsWith(prefix));
}

const EXPLICIT_CREATION_PATTERNS: readonly RegExp[] = [
  // "start/create/make/set up/open/build a project"
  /\b(start|create|make|set ?up|open|build|spin ?up)\s+(a |an |the |another )?(new\s+)?(tracker\s+)?project\b/i,
  // "start/create/add a task" / "create a tracker task"
  /\b(start|create|make|add|put|register)\s+(a |an |the |another )?(new\s+)?(tracker\s+)?task\b/i,
  // "(track|log|put|add) this/it/that in/into the tracker"
  /\b(track|log|put|add)\s+(this|it|that|these|them)\s+(in|into|on|to)\s+(the\s+)?tracker\b/i,
  // "tracker entry for X"
  /\b(open|create|make|start)\s+(a |an |the )?(tracker\s+entry|tracker\s+item|tracker\s+record)\b/i,
];

export function userExplicitlyAsksToCreateTracker(query: string): boolean {
  return EXPLICIT_CREATION_PATTERNS.some((re) => re.test(query));
}

// ── Top-level decision ──

export interface MultistepDecision {
  multistep: boolean;
  /** Suggested project name, or null. Caller may fall back to first 50 chars. */
  name: string | null;
  /** How we decided — for logging. */
  source:
    | 'heuristic_single' | 'heuristic_multi'
    | 'llm_single' | 'llm_multi'
    | 'fallback_multi' | 'fallback_single_question' | 'fallback_single_default'
    | 'disabled' | 'user_creating_explicitly' | 'engine_message';
  heuristic: MultistepHeuristic;
}

export async function detectMultistep(
  query: string,
  agentId: string,
  config: MultistepConfig = getMultistepConfig(),
): Promise<MultistepDecision> {
  const heuristic = multistepHeuristic(query);

  if (!config.enabled) {
    return { multistep: false, name: null, source: 'disabled', heuristic };
  }

  // Engine-generated user-role messages (rename requests, A2A pokes,
  // scheduler payloads, source-tagged notifications) are never user
  // intent. Skip auto-create — otherwise PM/sensei agents would
  // recursively auto-create projects FROM the rename requests we send
  // them.
  if (looksLikeEngineMessage(query)) {
    return { multistep: false, name: null, source: 'engine_message', heuristic };
  }

  // v2.5.46 — explicit project-creation request → skip auto-create.
  // The user wants the agent to build the structure themselves; an
  // auto-created umbrella task would be redundant and would orphan
  // when the agent finishes their own structure.
  if (userExplicitlyAsksToCreateTracker(query)) {
    return { multistep: false, name: null, source: 'user_creating_explicitly', heuristic };
  }

  if (heuristic.decision === 'definitely_single') {
    return { multistep: false, name: null, source: 'heuristic_single', heuristic };
  }

  if (heuristic.decision === 'definitely_multi') {
    // Skip LLM round-trip — the heuristic is already confident. Caller
    // can fall back to a prompt-derived name.
    return { multistep: true, name: null, source: 'heuristic_multi', heuristic };
  }

  // Ambiguous — try the System model if one is configured.
  const llm = await multistepLLMClassify(query, agentId, config.timeoutMs);
  if (llm === null) {
    // v2.5.46 (revised) — When the heuristic is genuinely uncertain AND no
    // local-LLM classifier is wired up, default to SINGLE. Earlier we
    // defaulted to multi ("over-creation is annoying but missing multi-step
    // is worse"), but in practice over-creation triggers the close-out gate
    // loop and produces 2-3 replies for one user prompt. The v2.5.46 reflex
    // bullets + close-out gate already direct agents to call
    // tracker_create_project themselves when work is genuinely multi-step —
    // trust the agent rather than preempting.
    if (looksLikeQuestion(query)) {
      return { multistep: false, name: null, source: 'fallback_single_question', heuristic };
    }
    return { multistep: false, name: null, source: 'fallback_single_default', heuristic };
  }

  return {
    multistep: llm.multistep,
    name: llm.name,
    source: llm.multistep ? 'llm_multi' : 'llm_single',
    heuristic,
  };
}
