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

/**
 * Try the token against ACTION_VERBS in a few morphological forms.
 * Catches "pulling" / "pulled" / "summarizing" / "summarised" without
 * requiring every conjugation in the set.
 */
function matchesActionVerb(token: string): boolean {
  if (ACTION_VERBS.has(token)) return true;

  // -s plural / 3rd-person singular: "pulls" → "pull"
  if (token.endsWith('s') && ACTION_VERBS.has(token.slice(0, -1))) return true;

  // -ed past tense: "pulled" → "pull"; "summarized" → "summariz" + "e"
  if (token.endsWith('ed')) {
    const stem = token.slice(0, -2);
    if (ACTION_VERBS.has(stem)) return true;
    if (ACTION_VERBS.has(stem + 'e')) return true;
  }

  // -ing present participle: "pulling" → "pull"; "summarizing" → "summarize"
  if (token.endsWith('ing')) {
    const stem = token.slice(0, -3);
    if (ACTION_VERBS.has(stem)) return true;
    if (ACTION_VERBS.has(stem + 'e')) return true;
  }

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
  for (const t of tokens) {
    if (matchesActionVerb(t)) actionVerbs++;
    if (CONJUNCTIONS.has(t)) conjunctions++;
  }

  let deliverables = 0;
  for (const re of DELIVERABLE_HINTS) {
    if (re.test(lower)) deliverables++;
  }

  const chars = query.length;

  // Scoring: weight action verbs heaviest. Two distinct action verbs
  // joined by a conjunction is the canonical multi-step signal.
  const score = actionVerbs * 1.0 + Math.min(conjunctions, 3) * 0.5 + deliverables * 0.6;

  let decision: HeuristicDecision;
  if (chars < 20 && actionVerbs <= 1) {
    decision = 'definitely_single';
  } else if (actionVerbs >= 3 || (actionVerbs >= 2 && conjunctions >= 1)) {
    decision = 'definitely_multi';
  } else if (actionVerbs === 0 && deliverables === 0) {
    decision = 'definitely_single';
  } else {
    decision = 'ambiguous';
  }

  return {
    decision,
    score,
    signals: { actionVerbs, conjunctions, deliverables, chars },
  };
}

// ── Local-LLM classifier ──

export interface MultistepLLMResult {
  multistep: boolean;
  name: string | null;
}

/**
 * Call the configured local Ollama model to classify the prompt and
 * (if multi-step) propose a short project name. Returns null on any
 * failure — caller falls back to heuristic-only behavior.
 */
export async function multistepLLMClassify(
  query: string,
  config: MultistepConfig,
): Promise<MultistepLLMResult | null> {
  if (!config.model) return null;

  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const prompt =
    'You are a classifier. Decide if the user task below is multi-step (more than 2 distinct actions or deliverables) or single-step.\n' +
    'Reply with JSON only, no prose:\n' +
    '{"multistep": true|false, "name": "3-5 word project name or null"}\n\n' +
    `Task: ${query}`;

  try {
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        prompt,
        stream: false,
        format: 'json',
        options: { temperature: 0.1, num_predict: 80 },
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    if (!response.ok) {
      logger.warn('Multistep LLM classifier HTTP error', { status: response.status });
      return null;
    }

    const data = await response.json() as { response?: string };
    const raw = data.response ?? '';
    const parsed = JSON.parse(raw) as { multistep?: unknown; name?: unknown };

    const multistep = parsed.multistep === true;
    const name = typeof parsed.name === 'string' && parsed.name.trim().length > 0
      ? parsed.name.trim().slice(0, 80)
      : null;

    return { multistep, name };
  } catch (err) {
    logger.warn('Multistep LLM classifier failed (non-fatal — falling back to heuristic)', {
      error: err instanceof Error ? err.message : String(err),
      model: config.model,
    });
    return null;
  }
}

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
  source: 'heuristic_single' | 'heuristic_multi' | 'llm_single' | 'llm_multi' | 'fallback_multi' | 'disabled' | 'user_creating_explicitly';
  heuristic: MultistepHeuristic;
}

export async function detectMultistep(
  query: string,
  config: MultistepConfig = getMultistepConfig(),
): Promise<MultistepDecision> {
  const heuristic = multistepHeuristic(query);

  if (!config.enabled) {
    return { multistep: false, name: null, source: 'disabled', heuristic };
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

  // Ambiguous — try LLM if configured.
  const llm = await multistepLLMClassify(query, config);
  if (llm === null) {
    // No LLM available or call failed. Fool-proof bias: lean toward
    // creating the project. Over-creation is annoying; missing the
    // multi-step case is the failure mode the user actually cares about.
    return { multistep: true, name: null, source: 'fallback_multi', heuristic };
  }

  return {
    multistep: llm.multistep,
    name: llm.name,
    source: llm.multistep ? 'llm_multi' : 'llm_single',
    heuristic,
  };
}
