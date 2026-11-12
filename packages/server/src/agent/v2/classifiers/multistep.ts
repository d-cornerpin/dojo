// Multi-step detection: when confident the engine creates the tracker project before the agent
// starts: prompt instructions don't reliably get followed. An optional LLM pass covers ambiguous ones.

import { getDb } from '../../../db/connection.js';
import { createLogger } from '../../../logger.js';

const logger = createLogger('classifier:multistep');

// ── Config ──

export interface MultistepConfig {
  enabled: boolean;
  /** Ollama model name (e.g. "qwen2.5:7b"). null means heuristic-only. */
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
    /** Sentence/clause boundaries between imperatives: coordination, like "and". */
    clauseBoundaries: number;
    deliverables: number;
    chars: number;
  };
}

// Action verbs the agent must DO, not just answer. Tense-folded; the input is lowercased.
const ACTION_VERBS = new Set([
  'pull', 'fetch', 'get', 'grab', 'download', 'retrieve',
  'send', 'email', 'message', 'text', 'imessage', 'post', 'publish',
  'create', 'make', 'build', 'generate', 'draft', 'write', 'compose',
  'summarize', 'summarise', 'compile', 'aggregate', 'gather',
  'find', 'search', 'look', 'lookup', 'investigate', 'check',
  'research', 'compare', 'contrast', 'weigh',
  'update', 'edit', 'change', 'modify', 'fix', 'patch',
  'delete', 'remove', 'clear', 'archive',
  'schedule', 'plan', 'organize', 'organise',
  'analyze', 'analyse', 'review', 'audit', 'evaluate',
  'remind', 'notify', 'alert',
  'export', 'import', 'backup', 'restore',
  'attach', 'upload', 'save',
  'split', 'divide', 'distribute', 'combine',
]);

const CONJUNCTIONS = new Set(['and', 'then', 'also', 'plus', 'after', 'next']);

// A determiner or quantifier right before a candidate ("email the team" vs "any new emails")
// means the candidate is a noun: counting it would fire multistep on a plain lookup question.
const NOUNIFYING_PREDECESSORS = new Set([
  'any', 'the', 'a', 'an',
  'my', 'your', 'his', 'her', 'its', 'our', 'their',
  'some', 'this', 'that', 'these', 'those',
  'few', 'several', 'many', 'all', 'no', 'every',
  'each', 'another', 'such',
  'new', 'old', 'recent', 'latest', 'pending', 'unread',
]);

/** Try a token against ACTION_VERBS in a few morphological forms ("pulling", "pulled",
 *  "summarised"), so every conjugation need not live in the set. */
function matchesActionVerb(token: string, prevToken: string | null): boolean {
  const candidateIsVerbLike =
    ACTION_VERBS.has(token) ||
    (token.endsWith('s') && ACTION_VERBS.has(token.slice(0, -1))) ||
    (token.endsWith('ed') && (ACTION_VERBS.has(token.slice(0, -2)) || ACTION_VERBS.has(token.slice(0, -2) + 'e'))) ||
    (token.endsWith('ing') && (ACTION_VERBS.has(token.slice(0, -3)) || ACTION_VERBS.has(token.slice(0, -3) + 'e')));

  if (!candidateIsVerbLike) return false;

  if (prevToken && NOUNIFYING_PREDECESSORS.has(prevToken)) return false;

  return true;
}

// A prompt asking for information is almost always a single-step lookup: the tiebreaker for
// ambiguous cases and the fallback bias when no LLM classifier is configured.
const INTERROGATIVE_LEAD =
  /^\s*(do|does|did|is|are|am|was|were|will|would|can|could|should|shall|may|might|have|has|had|what|whats|where|wheres|when|whens|why|whys|who|whos|whom|whose|which|how|hows)\b/i;

export function looksLikeQuestion(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.endsWith('?')) return true;
  if (INTERROGATIVE_LEAD.test(trimmed)) return true;
  return false;
}

// Deliverable nouns: a discrete output the agent must produce, with or without a conjunction.
// Explicit entries, never a stemmer: derivational folds would flip verdicts no reader can predict.
const DELIVERABLE_HINTS = [
  /\bsummary\b/, /\breport\b/, /\bdoc(?:ument)?\b/, /\bemail\b/,
  /\bmessage\b/, /\blist\b/, /\boverview\b/, /\bbreakdown\b/,
  /\bdigest\b/, /\bbrief\b/,
  /\bcomparison\b/, /\brecommendation\b/, /\bwrite-?up\b/,
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

  // Clause boundaries are coordination: "Make X. Generate Y." asks for two things like "and".
  // The tokenizer strips punctuation, so count boundaries on the raw text; a terminator counts
  // only when a word starts after a space, so "report.txt" or a trailing "." never registers.
  const clauseBoundaries = (lower.match(/[.!?;\n]+\s+(?=[a-z0-9])/g) ?? []).length;
  const coordination = conjunctions + clauseBoundaries;

  const chars = query.length;
  const isQuestion = looksLikeQuestion(query);

  // Two distinct action verbs joined by coordination is the canonical multi-step signal.
  const score = actionVerbs * 1.0 + Math.min(coordination, 3) * 0.5 + deliverables * 0.6;

  let decision: HeuristicDecision;
  if (chars < 20 && actionVerbs <= 1) {
    decision = 'definitely_single';
  } else if (actionVerbs >= 3 || (actionVerbs >= 2 && coordination >= 1)) {
    // Multi-step even as a question or split across sentences: "find X, summarize it, email it".
    decision = 'definitely_multi';
  } else if (isQuestion && actionVerbs <= 1 && conjunctions === 0) {
    // A question with at most one action verb and no conjunction: a lookup, not a project.
    decision = 'definitely_single';
  } else if (actionVerbs <= 1 && conjunctions === 0) {
    // One action, no conjunction joining more work: a single imperative ("Send an email
    // saying hi") is one task, not a project; auto-creating here loops the close-out gate.
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

/** Tolerant JSON extraction: cloud models may wrap the object in prose or fences, unlike
 *  Ollama's forced `format: 'json'`. Parse the first balanced-looking {...}. */
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

/** Classify an ambiguous prompt with the SYSTEM router model, routed through callModel so it
 *  can be cloud OR local. Null on failure or no System model: the caller falls back to heuristic. */
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
      // A small engine artifact: thinking off, 48-token cap, window sized to the prompt.
      purpose: 'multistep_classify',
      abortSignal: AbortSignal.timeout(timeoutMs),
      // Fully handled: any failure falls back to the heuristic in the catch below, so
      // bestEffort stops the provider logging an already-recovered timeout as an error.
      bestEffort: true,
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

// Engine-created projects carry root_kind='engine_scaffold', a column stamped at creation and
// declared once in work/tracker-view.ts. The requirement it serves: "this row was opened by the
// engine, not by an agent", which the near-duplicate steer and rename handoff still need.

// ── User explicitly requesting project creation ──

// An explicit creation request ("start a project") skips auto-create: the agent builds their own
// structure; an auto-created umbrella task would be a redundant orphan next to it.

// Engine-injected user-role messages are never user intent: they carry action verbs and would
// make the receiving agent auto-create a project from the engine's own handoff text.
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
  /\b(start|create|make|set ?up|open|build|spin ?up)\s+(a |an |the |another )?(new\s+)?(tracker\s+)?project\b/i,
  /\b(start|create|make|add|put|register)\s+(a |an |the |another )?(new\s+)?(tracker\s+)?task\b/i,
  /\b(track|log|put|add)\s+(this|it|that|these|them)\s+(in|into|on|to)\s+(the\s+)?tracker\b/i,
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
  /** How we decided, for logging. */
  source:
    | 'heuristic_single' | 'heuristic_multi'
    | 'llm_single' | 'llm_multi' | 'decision_single' | 'decision_multi'
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

  if (looksLikeEngineMessage(query)) {
    return { multistep: false, name: null, source: 'engine_message', heuristic };
  }

  if (userExplicitlyAsksToCreateTracker(query)) {
    return { multistep: false, name: null, source: 'user_creating_explicitly', heuristic };
  }

  if (heuristic.decision === 'definitely_single') {
    return { multistep: false, name: null, source: 'heuristic_single', heuristic };
  }

  if (heuristic.decision === 'definitely_multi') {
    // The heuristic is confident: skip the LLM call, name falls back to the prompt.
    return { multistep: true, name: null, source: 'heuristic_multi', heuristic };
  }

  // Ambiguous: try the System model if one is configured.
  const llm = await multistepLLMClassify(query, agentId, config.timeoutMs);
  if (llm === null) {
    // Uncertain with no model wired: default SINGLE. Over-creation loops the close-out gate
    // (2-3 replies per user prompt); reflex bullets already make agents open projects themselves.
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
