// ════════════════════════════════════════
// Engine ack copy, varied "on it" / "done" lines
//
// The engine guarantees the person who asked hears an acknowledgment when
// their request is judged project-worthy (start) and again when the work
// finishes (completion). The GUARANTEE is a hard requirement from a
// production failure (the floor model ended a turn on an A2A send and the
// owner heard nothing). The WORDING is best-effort: an identical fixed
// string every time reads as robotic, so we vary it.
//
// Two sources, in order:
//   1. Model path: if a SYSTEM model is configured (Settings -> Router), one
//      bounded, best-effort call writes a short line that fits what the user
//      actually asked. Same shape as the multistep classifier's system-model
//      round-trip: getSystemModel() + callModel({ bestEffort, abortSignal }).
//   2. Pool path (the guaranteed fallback): a set of varied canned lines,
//      picked so the same one never repeats back-to-back. First-class, not an
//      afterthought. On a box with no system model this is the ONLY path.
//
// The compose functions ALWAYS resolve to a usable string (pool fallback on
// any model failure/timeout/validation miss), so a caller can fire them
// fire-and-forget and be sure an ack lands.
//
// House style for every line here: casual, plain, everyday language; no
// questions, no emoji, no names, no em-dashes.
// ════════════════════════════════════════

import { createLogger } from '../../logger.js';

const logger = createLogger('ack-copy');

/** Bounded budget for the best-effort system-model wording call. */
export const DEFAULT_ACK_COMPOSE_TIMEOUT_MS = 2000;

// ── Pools ──

// Fresh start: the person just asked, the agent is picking it up.
const START_ACK_POOL: readonly string[] = [
  "On it. I'll let you know when it's done.",
  "Working on it now, I'll report back shortly.",
  "Got it, starting on this now.",
  "Picking this up now.",
  "On it, give me a few minutes.",
  "Sure thing, getting started on this.",
  "Alright, I'm on it. I'll circle back when it's ready.",
  "On it now, I'll follow up once it's done.",
  "Cool, diving into this now.",
  "Starting on this, back with you soon.",
];

// Mid-work flavor: the engine noticed in-flight work is project-worthy and
// opened a task for it, so the note reads "already in progress", not "starting".
const PROGRESS_ACK_POOL: readonly string[] = [
  "Quick note, I've got this in progress and I'll let you know when it's done.",
  "Just so you know, I'm working through this now.",
  "Still on this, I'll follow up once it's wrapped up.",
  "Heads up, this is underway. More soon.",
  "Making progress on this, I'll report back when it's done.",
];

// Finished. The caller appends the result line after this sentence, so each
// line has to read cleanly both on its own and with a result trailing it.
const COMPLETION_ACK_POOL: readonly string[] = [
  "Done, that's all wrapped up.",
  "All set, that's finished.",
  "Done, that's taken care of.",
  "Finished, that's done.",
  "Okay, that's complete.",
];

// ── Pool selection (no immediate repeats) ──

const startPick = { last: -1 };
const progressPick = { last: -1 };
const completionPick = { last: -1 };

function pickFromPool(pool: readonly string[], state: { last: number }): string {
  if (pool.length === 0) return '';
  if (pool.length === 1) return pool[0] ?? '';
  let idx = Math.floor(Math.random() * pool.length);
  if (idx === state.last) idx = (idx + 1) % pool.length;
  state.last = idx;
  return pool[idx] ?? pool[0] ?? '';
}

/** Pool-only start line (the guaranteed fallback), exported for direct use. */
export function pickStartAck(phase: StartAckPhase = 'start'): string {
  return phase === 'inprogress'
    ? pickFromPool(PROGRESS_ACK_POOL, progressPick)
    : pickFromPool(START_ACK_POOL, startPick);
}

/** Pool-only completion line (the guaranteed fallback), exported for direct use. */
export function pickCompletionAck(): string {
  return pickFromPool(COMPLETION_ACK_POOL, completionPick);
}

// ── Validation ──

// A model-written line only ships if it is a single clean sentence. Anything
// that smells like reasoning, a bracketed engine marker, a question, or an
// em-dash falls through to the pool. Keeps the guarantee (an ack always
// lands) while never letting a malformed model line reach the user.
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}]/u;

function validateAckLine(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  // Models sometimes wrap the line in quotes; strip a single surrounding pair.
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    s = s.slice(1, -1).trim();
  }
  if (s.length === 0 || s.length > 140) return null;
  if (s.includes('\n') || s.includes('\r')) return null; // single line only
  if (s.includes('?')) return null;                       // no questions
  if (s.startsWith('[')) return null;                     // no bracket/engine prefixes
  if (s.includes('—') || s.includes('--')) return null;   // no em-dashes
  if (EMOJI_RE.test(s)) return null;                      // no emoji
  return s;
}

// ── Model path ──

async function modelAckLine(prompt: string, agentId: string, timeoutMs: number): Promise<string | null> {
  if (!agentId) return null;
  try {
    const { getSystemModel } = await import('../../router/selector.js');
    const systemModel = getSystemModel();
    if (!systemModel) return null; // no system model on this box, pool it

    const { callModel } = await import('../model.js');
    const result = await callModel({
      agentId,
      modelId: systemModel,
      systemPrompt: '',
      messages: [{ role: 'user', content: prompt }],
      tools: false,
      // Best-effort: any failure/timeout is fully handled by the pool
      // fallback in the caller, so the provider layer logs at WARN not ERROR.
      bestEffort: true,
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
    return validateAckLine(result.content);
  } catch (err) {
    logger.warn('ack-copy: system-model wording failed (non-fatal, using pool)', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return null;
  }
}

function truncateContext(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

export type StartAckPhase = 'start' | 'inprogress';

export interface ComposeStartAckArgs {
  /** The user's request, for context so the line can fit the ask. */
  userMessage: string;
  agentId: string;
  timeoutMs?: number;
  /** 'start' (fresh ask) or 'inprogress' (engine opened a task mid-work). */
  phase?: StartAckPhase;
}

export interface ComposeCompletionAckArgs {
  /** The result text the caller will append; passed for model context only. */
  resultLine: string;
  agentId: string;
  timeoutMs?: number;
}

/**
 * A short acknowledgment that the assistant is starting on (or is mid-way
 * through) the user's request and will report back. Best-effort model wording,
 * guaranteed pool fallback. Always resolves to a usable line.
 */
export async function composeStartAck(args: ComposeStartAckArgs): Promise<string> {
  const timeoutMs = args.timeoutMs ?? DEFAULT_ACK_COMPOSE_TIMEOUT_MS;
  const phase = args.phase ?? 'start';
  const ctx = truncateContext(args.userMessage);
  const verb = phase === 'inprogress'
    ? 'that you are already working on the user request and will report back when it is done'
    : 'that you are starting on the user request and will report back when it is done';
  const prompt =
    `Write ONE short, casual acknowledgment ${verb}. ` +
    'Plain everyday language, under 15 words. No questions, no emoji, no names, no em-dashes, ' +
    'and do not promise any specific result. Reply with only the acknowledgment text, nothing else.' +
    (ctx ? `\n\nThe user asked: "${ctx}"` : '');

  const fromModel = await modelAckLine(prompt, args.agentId, timeoutMs);
  return fromModel ?? pickStartAck(phase);
}

/**
 * A short acknowledgment that the assistant has FINISHED. The caller appends
 * the concrete result line after this sentence. Best-effort model wording,
 * guaranteed pool fallback. Always resolves to a usable line.
 */
export async function composeCompletionAck(args: ComposeCompletionAckArgs): Promise<string> {
  const timeoutMs = args.timeoutMs ?? DEFAULT_ACK_COMPOSE_TIMEOUT_MS;
  const ctx = truncateContext(args.resultLine);
  const prompt =
    'Write ONE short, casual acknowledgment that you have finished what the user asked for. ' +
    'Plain everyday language, under 15 words. No questions, no emoji, no names, no em-dashes. ' +
    'Do not restate the details of the result. Reply with only the acknowledgment text, nothing else.' +
    (ctx ? `\n\nFor context, the result was: "${ctx}"` : '');

  const fromModel = await modelAckLine(prompt, args.agentId, timeoutMs);
  return fromModel ?? pickCompletionAck();
}
