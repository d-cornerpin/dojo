// ════════════════════════════════════════
// Tier Decision Orchestrator
// One entry point for "what tier should this turn use". Layered:
//   1. Structural hard rules (vision -> heavy) — context the query embedding
//      can't see.
//   2. Semantic classification (trained head if present, else exemplar
//      centroids), trusted when its confidence margin clears a floor.
//   3. Keyword heuristic fallback (scorer.ts), which also carries context
//      signals like conversation momentum, used when semantic is low-confidence
//      or the embedder is unavailable.
// See SEMANTIC-ROUTER-PLAN (local doc).
// ════════════════════════════════════════

import { createLogger } from '../logger.js';
import { scoreQuery } from './scorer.js';
import { classifyTierSemantic } from './semantic.js';
import type { DimensionScore } from './types.js';

const logger = createLogger('router-decide');

export type RouteMethod = 'structural' | 'semantic' | 'heuristic' | 'fallback';
export type Tier = 'light' | 'standard' | 'heavy';

export interface RouteDecision {
  tier: Tier;
  method: RouteMethod;
  confidence: number;
  scores: DimensionScore[];
  rawScore: number;
  latencyMs: number;
  headVersion: string | null;
  queryPreview: string;
}

type Msg = { role: string; content: string | object[] };

// A short confirmation ("yes", "go ahead", "do it") carries almost no semantic
// signal on its own, so the classifier would route it by its surface text
// (usually 'light') and drop tier mid-task. Instead we treat it structurally:
// the user is greenlighting the actual request they made just before, so we
// route the confirmation at the tier of THAT request (carry the task forward).
const SHORT_CONFIRM = /^(yes|yeah|yep|yup|ok|okay|sure|sounds good|go|go ahead|do it|go for it|proceed|approved|confirmed|let'?s go|please do|continue|run it|ship it)\b/i;

function textOf(content: string | object[]): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(b => (typeof b === 'object' && b !== null && 'text' in b) ? (b as { text: string }).text : '')
      .join('\n');
  }
  return '';
}

function lastUserText(messages: Msg[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return textOf(messages[i].content);
  }
  return '';
}

function shortConfirmation(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= 30 && SHORT_CONFIRM.test(t);
}

// Engine-injected user-role messages (technique hints, etc.) ride in the
// messages array but are NOT the user's words. Skip them when finding the real
// query and the real prior request, so routing classifies the human, not the
// engine's scaffolding.
const ENGINE_MARKERS = [
  '## Possibly Relevant Techniques',
  '## Other Techniques That Might Also Apply',
  '[DOJO TECHNIQUE',
  '[Engine',
];
function isEngineInjection(text: string): boolean {
  const t = text.trimStart();
  return ENGINE_MARKERS.some(m => t.startsWith(m));
}

// The most recent real user request before a confirmation (skips the
// confirmation itself, other short acks, and engine injections).
function priorSubstantiveUserText(messages: Msg[], currentQuery: string): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue;
    const t = textOf(messages[i].content).trim();
    if (!t || t === currentQuery.trim()) continue;
    if (t.length <= 15) continue;
    if (shortConfirmation(t)) continue;
    if (isEngineInjection(t)) continue;
    return t;
  }
  return '';
}

function hasVision(messages: Msg[]): boolean {
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (typeof b === 'object' && b !== null) {
        const t = (b as Record<string, unknown>).type;
        if (t === 'image' || t === 'image_url') return true;
      }
    }
  }
  return false;
}

export async function decideTier(
  systemPrompt: string,
  messages: Msg[],
  agentId: string,
  userText?: string | null,
): Promise<RouteDecision> {
  const start = performance.now();
  // Prefer the authoritative trigger text (clean of engine injections); fall
  // back to scanning messages only if the caller didn't supply it.
  const query = (userText ?? lastUserText(messages)) ?? '';
  const queryPreview = query.slice(0, 120);

  // 1. Structural: vision/multimodal always needs a capable model.
  if (hasVision(messages)) {
    return {
      tier: 'heavy', method: 'structural', confidence: 1,
      scores: [], rawScore: 0, latencyMs: performance.now() - start,
      headVersion: null, queryPreview,
    };
  }

  // 2. Structural: short confirmation -> inherit the tier of the request being
  //    greenlit, so "yes, do it" after a heavy ask stays heavy.
  if (shortConfirmation(query)) {
    const prior = priorSubstantiveUserText(messages, query);
    if (prior) {
      const semPrior = await classifyTierSemantic(prior).catch(() => null);
      if (semPrior) {
        return {
          tier: semPrior.tier, method: 'structural', confidence: semPrior.confidence,
          scores: [], rawScore: semPrior.topScore, latencyMs: performance.now() - start,
          headVersion: semPrior.headVersion, queryPreview,
        };
      }
    }
    // No prior request (or embedder down) -> fall through to normal handling.
  }

  // 3. Semantic. Trust the classifier's top tier whenever the embedder worked;
  //    its pick (even at a low top-2 margin) beats the keyword scorer, which is
  //    exactly the thing we are replacing. The heuristic is only a safety net
  //    for when the embedder is unavailable. The margin is still reported as
  //    confidence so the low-confidence shadow probe can target uncertain calls.
  try {
    const sem = await classifyTierSemantic(query);
    if (sem) {
      return {
        tier: sem.tier, method: 'semantic', confidence: sem.confidence,
        scores: [], rawScore: sem.topScore, latencyMs: performance.now() - start,
        headVersion: sem.headVersion, queryPreview,
      };
    }
    // Embedder unavailable -> keyword heuristic safety net.
    const h = scoreQuery(systemPrompt, messages);
    return {
      tier: h.tier, method: 'fallback', confidence: h.confidence,
      scores: h.scores, rawScore: h.rawScore, latencyMs: performance.now() - start,
      headVersion: null, queryPreview,
    };
  } catch (err) {
    logger.warn('Semantic routing errored; heuristic fallback', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
    const h = scoreQuery(systemPrompt, messages);
    return {
      tier: h.tier, method: 'fallback', confidence: h.confidence,
      scores: h.scores, rawScore: h.rawScore, latencyMs: performance.now() - start,
      headVersion: null, queryPreview,
    };
  }
}
