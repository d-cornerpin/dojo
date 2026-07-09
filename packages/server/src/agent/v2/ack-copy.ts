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

// A2A-handoff floor fallback: a user-triggered turn is ending because work was
// handed to another agent (whose reply is asynchronous) and the model sent the
// user nothing at the end. The engine delivers one of these so the user is
// never left in silence; the model was already steered once and did not send.
const A2A_HANDOFF_ACK_POOL: readonly string[] = [
  "I've pulled in another agent on part of this and I'll report back as soon as they answer.",
  "Part of this is now with another agent; I'll follow up the moment I hear back.",
  "I've handed a piece of this off and will let you know as soon as the answer comes back.",
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
const a2aHandoffPick = { last: -1 };

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

/** Pool-only A2A-handoff notice (the hard-floor fallback), exported for direct use. */
export function pickA2AHandoffAck(): string {
  return pickFromPool(A2A_HANDOFF_ACK_POOL, a2aHandoffPick);
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

// ── Deliverable handoff (completion-ack link extraction + prose condensing) ──
//
// When the engine composes a completion ack on the model's behalf (the model
// finished the work but went silent), the person still needs the DELIVERABLE,
// e.g. the link to the doc/sheet/file that was just created. A production
// failure delivered a "done" line with the task result sliced at 200 chars,
// which cut mid-word and BEFORE the link. These two pure helpers fix the
// handoff: pull the link out whole first, then condense the prose separately.

// The labeled deliverable-link line shapes OUR OWN create tools emit. We key
// ONLY on these (never scrape arbitrary URLs out of, e.g., web_fetch results,
// which would hand the user a random link): Docs / Sheets / Drive / folder /
// calendar emit "Link: <url>"; OneDrive / office emit "Open: <url>" and
// "Share link: <url>". Anchored at line start so a "Weblink:" or a "File ID:"
// line can never match.
const DELIVERABLE_LINK_LINE_RE = /^\s*(?:Link|Open|Share link)\s*:\s*(https?:\/\/\S+)/i;

/** Trim trailing punctuation a URL almost never really ends on. */
function trimUrlTail(url: string): string {
  return url.replace(/[).,;\]]+$/, '');
}

/**
 * Pull the deliverable link(s) the user is meant to receive out of a set of
 * tool-result strings. Keys ONLY on the "Link:" / "Open:" / "Share link:"
 * labeled lines our create tools emit, so it never returns a stray URL from
 * web_fetch or other arbitrary tool output. Returns unique, in-order, WHOLE
 * URLs (never truncated). Pure, no I/O.
 */
export function extractDeliverableLinks(
  toolResultContents: readonly (string | null | undefined)[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of toolResultContents) {
    if (!raw) continue;
    for (const line of raw.split('\n')) {
      const m = line.match(DELIVERABLE_LINK_LINE_RE);
      if (!m || !m[1]) continue;
      const url = trimUrlTail(m[1]);
      if (url && !seen.has(url)) { seen.add(url); out.push(url); }
    }
  }
  return out;
}

// ── Forward-promise detection (promise floor) ──
//
// The last member of the fall-asleep family: a turn whose ENTIRE deliverable is
// a promise to start ("On it. Let me pull up all your calendars.") with no tool
// call and nothing actually done. Every other engine floor keys on tasks or
// deliveries; this one keys on the SHAPE of the reply. Pure + exported so the
// promise floor in loop.ts and its unit test share ONE definition.
//
// Deliberately conservative: this is only ONE of the three conditions the floor
// requires (the others, checked in loop.ts, are a real user trigger and
// negligible work this turn), so it leans toward NOT firing on ambiguous text.
//   - It keys on the LAST sentence (the ending intent), so a reply that promises
//     and then delivers ("Let me check the weather. It is sunny and 72.") reads
//     as a delivery, not a promise.
//   - A question mark ANYWHERE means the reply asked the user something, a
//     legitimate ending, never a promise.
//   - The "let me know" idiom is an invitation, not a promise, and is excluded.
const FORWARD_PROMISE_PATTERNS: readonly RegExp[] = [
  /\blet me (?:go |just )?(?:pull|check|get|grab|look|dig|start|put|gather|compile|run)\b/i,
  /\bi(?:'|’)?ll (?:go |just )?(?:pull|check|get|start|put|look|gather|compile|run|do|work)\b/i,
  /\bgive me a (?:sec|second|minute|moment|few)\b/i,
  /\bone (?:sec|second|moment)\b/i,
  /\bhang on\b/i,
  /\bhold on\b/i,
  /\b(?:about|going) to (?:pull|check|get|start|gather|run)\b/i,
  /\bback (?:with you |to you )?(?:shortly|soon|in a (?:bit|minute|few))\b/i,
];

/**
 * True when `text` reads as a bare forward promise to START work (with nothing
 * delivered), judged by its ENDING. Pure; the caller pairs it with the other two
 * floor conditions before acting. See FORWARD_PROMISE_PATTERNS above for the
 * conservatism rationale.
 */
export function isForwardPromiseReply(text: string | null | undefined): boolean {
  if (!text) return false;
  const s = text.replace(/\s+/g, ' ').trim();
  if (!s) return false;
  // A question anywhere = the reply asked the user something = a valid ending.
  if (s.includes('?')) return false;
  // Only the LAST sentence carries the ending intent: a promise that is a
  // preamble the reply then delivers past is not a bare promise.
  const sentences = s.split(/(?<=[.!])\s+/).map((x) => x.trim()).filter(Boolean);
  const tail = sentences.length > 0 ? sentences[sentences.length - 1] : s;
  // Strip a trailing "let me know ..." invitation so it can never BE the match
  // (an offer to hear back, not a promise to go do work now).
  const region = tail.replace(/\blet me know\b.*$/i, '').trim();
  if (!region) return false;
  return FORWARD_PROMISE_PATTERNS.some((re) => re.test(region));
}

/** Default cap for the condensed task-result prose in a completion ack. */
export const RESULT_PROSE_MAX_CHARS = 400;

/**
 * Condense a model-written task-result string for a completion ack. Collapses
 * whitespace, drops any URLs that will be shown on their own line (so they are
 * not duplicated or left as a fragment), then truncates to ~400 chars at a WORD
 * boundary with an ellipsis, never mid-word. Because a URL contains no spaces,
 * cutting at the last word boundary guarantees any remaining URL survives WHOLE
 * or is dropped WHOLE (the caller shows the extracted links separately). Pure.
 */
export function condenseResultProse(
  raw: string | null | undefined,
  opts: { maxChars?: number; dropUrls?: readonly string[] } = {},
): string {
  const maxChars = opts.maxChars ?? RESULT_PROSE_MAX_CHARS;
  let s = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  for (const url of opts.dropUrls ?? []) {
    if (url) s = s.split(url).join(' ');
  }
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s.length <= maxChars) return s;
  let cut = s.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > 0) cut = cut.slice(0, lastSpace);
  return cut.replace(/[\s.,;:]+$/, '') + '…';
}
