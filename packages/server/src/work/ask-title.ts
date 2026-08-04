// ════════════════════════════════════════════════════════════════════════════
// WHAT AN ASK TICKET IS CALLED (PHASE-5 T9 — the owner's decision D4)
//
// The ticket a person's message opens used to be titled with the first 120
// characters of that message. A title derived by SLICING is a copy: whatever
// the owner typed — including a credential he typed — was carried out of
// `messages` and into `work.title`, a cross-store surface with its own readers
// and its own lifetime. That mechanism is GONE; this module is what replaced
// it.
//
// THE DECISION: the title is WRITTEN BY THE SYSTEM MODEL — the same router
// tier that already serves the multi-step classifier and the voice opener. A
// title the model writes is a description of what is being asked, not a
// transcript of it.
//
// ── THE THREE REQUIREMENTS, each with the thing that holds it ──
//
//  1. THE ASK HAPPENS BEFORE THE WRITE OPENS. `insertMessage`'s own header
//     records the one-transaction invariant: the message row and the ticket it
//     opens are ONE unit, both or neither. The prohibition was never on
//     waiting — it is on holding a write transaction open across a network
//     call. So the model is asked FIRST, and the message and its ticket are
//     then written together with the real title already in place. No interim
//     value is ever written, and `withUnit` still compile-refuses an await.
//     Held by: `insertInboundMessageIfAbsent` below, and `SyncOnly<T>` in
//     `db/unit.ts`.
//
//  2. THE WAIT IS BOUNDED AND ITS FALLBACK IS CONTENT-FREE. On timeout, on any
//     provider failure, or when no system tier is configured, the ticket is
//     written with ITS OWN IDENTIFIER as the title — `askIdForMessage()`,
//     which is derived from the message id and therefore carries nothing a
//     person typed. **REFUSAL: the fallback is NEVER the 120-character slice.**
//     Re-introducing it on the timeout path would re-open the hole on exactly
//     the messages where the model was too slow to help. The bound is enforced
//     by a race here, not by trusting the provider layer to honour an abort.
//
//  3. AN INSTRUCTION TO A MODEL IS NOT A PROVEN REFUSAL. The prompt asks for a
//     title that copies no values; that request is a request. What makes it a
//     property is `acceptModelTitle()`, which runs the platform's EXISTING
//     declared-value scrub over the model's answer and REFUSES the whole title
//     if the scrub would change it — falling back to the ticket's own id.
//     **REFUSAL: the title is never "repaired" by writing the scrubbed form.**
//     A title that had to be scrubbed is a title the model copied from, and
//     what it copied the rest of is not knowable.
//     Held by: `memory/__tests__/ask-title-at-ingest.test.ts`, RED first.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ──
// It does not look at the SHAPE of anything. There is no "does this look like
// a key" test here and there must never be one: value-shaped matching is the
// class this overhaul removed, and the declared-value scrub is the platform's
// one principled answer to "is this string a secret" (`credentials/
// secret-values.ts` — a value is learned from a DECLARED field, never guessed).
// The scrub can only know values this process has handled; that is its stated
// scope, and it is a check ON TOP OF the model's answer, not a filter that
// makes the model's answer safe.
//
// ── THE TWO BOUNDS: ONE MEASURED, ONE THE PLATFORM'S OWN ──
// The length cap is `OPENER_MAX_CHARS = 80` from the voice opener
// (`voice/voice-ws.ts:1251`), the platform's other short model-written string.
//
// THE TIMEOUT WAS NOT INHERITED — IT WAS MEASURED, because the inherited one was
// wrong. This started at the voice opener's 1500 ms and that number never fires:
// driven on the box 2026-08-03 through this exact path (POST /api/chat/kevin/
// messages, wall clock at the caller, system tier = the floor model), NINE
// samples ran 2296 / 2577 / 2847 / 3246 / 3622 / 3670 / 3727 / 4215 / 5198 ms —
// median 3622, max 5198. At 1500 ms every inbound ask would take the fallback and
// the decision would be dead on arrival.
//
// 5000 ms is where it sits, and it is the platform's OTHER existing system-model
// bound (`multistepLLMClassify`'s default, `agent/v2/classifiers/multistep.ts`)
// rather than a number invented here. Against those nine samples it would have
// produced a real title on eight and taken the content-free fallback on one,
// which is the designed graceful path and not a failure.
//
// THE COST IS REAL AND IT IS THE OWNER'S ACCEPTED TRADE: an inbound ask now waits
// for its title before its row lands. Nothing else waits — a message that opens
// no ticket never calls a model at all.
// ════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';
import { redactHandedCredentials } from '../credentials/secret-values.js';
import {
  insertMessageIfAbsent, wouldOpenAsk, type NewMessage, type Persisted,
} from '../memory/message-store.js';

const logger = createLogger('ask-title');

/** How long ingest will wait for the system model before falling back. */
export const ASK_TITLE_TIMEOUT_MS = 5000;

/** The longest title written. */
export const ASK_TITLE_MAX_CHARS = 80;

/**
 * How much of the message the system model is shown. Bounded because this call
 * is on the ingest path of every inbound ask: a long paste must not turn one
 * message into an expensive request.
 */
export const ASK_TITLE_INPUT_CHARS = 2000;

const TITLE_INSTRUCTION = [
  'Write a short title for the request below, for a work tracker.',
  'Rules:',
  '- 3 to 8 words, describing WHAT IS BEING ASKED.',
  '- Never copy values out of the message: no keys, tokens, passwords, account',
  '  numbers, addresses, phone numbers, or quoted text.',
  '- Reply with the title only. No quotes, no punctuation at the end, no prose.',
].join('\n');

/**
 * THE CHECK (requirement 3). Turn whatever the model said into a title, or
 * refuse it.
 *
 * Returns `null` for "use the ticket's own identifier" — every caller treats
 * `null` that way and no caller may substitute anything else.
 */
export function acceptModelTitle(agentId: string, raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  // One line, no wrapping quotes, no "Title:" preamble, whitespace collapsed.
  let t = raw.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  t = t.replace(/^title\s*[:\-—]\s*/i, '');
  t = t.replace(/^["'`“”‘’]+/, '').replace(/["'`“”‘’]+$/, '');
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length > ASK_TITLE_MAX_CHARS) t = t.slice(0, ASK_TITLE_MAX_CHARS).trim();
  if (t.length === 0) {
    // Observed on the box: a system model can answer with nothing at all. The
    // fallback is correct and the ticket is fine — but a fallback nobody can see
    // is a mechanism that can rot in silence, so it says so.
    logger.warn('ask title: the system model answered with nothing usable '
      + '(falling back to the ticket id)', { agentId, answeredChars: raw.length });
    return null;
  }

  // THE CHECK. The instruction above asked the model not to copy values; this
  // is what makes that a property rather than a hope. If the platform's own
  // declared-value scrub would change this string, the model copied a value it
  // was told not to copy — the whole title is refused, never the scrubbed form.
  if (redactHandedCredentials(agentId, t) !== t) {
    logger.warn('ask title refused: the model copied a declared secret value into it — '
      + 'the ticket keeps its own identifier as its title', { agentId });
    return null;
  }
  return t;
}

/**
 * Ask the system model for this ask's title. Bounded; `null` means "the ticket
 * uses its own identifier".
 *
 * Never throws: an ingest path that could not get a title still has a person's
 * message to land, and a failure here may never cost that message.
 *
 * The two imports are dynamic for the reason the other two system-model callers
 * are (`agent/v2/classifiers/multistep.ts:280`, `voice/voice-ws.ts:1270`): the
 * model module reaches back into the message store, so a static import here is
 * a cycle.
 */
export async function resolveAskTitle(agentId: string, content: string): Promise<string | null> {
  if (!agentId || typeof content !== 'string' || content.trim().length === 0) return null;

  let systemModel: string | null = null;
  try {
    const { getSystemModel } = await import('../router/selector.js');
    systemModel = getSystemModel();
  } catch (err) {
    logger.warn('ask title: the system tier could not be read (falling back to the ticket id)', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return null;
  }
  // No system tier configured is a legitimate, supported state — the ticket
  // gets its own identifier and nothing about ingest changes.
  if (!systemModel) return null;

  let timer: NodeJS.Timeout | undefined;
  try {
    const { callModel } = await import('../agent/model.js');
    const answered = callModel({
      agentId,
      modelId: systemModel,
      systemPrompt: '',
      messages: [{ role: 'user', content: `${TITLE_INSTRUCTION}\n\n${content.slice(0, ASK_TITLE_INPUT_CHARS)}` }],
      tools: false,
      abortSignal: AbortSignal.timeout(ASK_TITLE_TIMEOUT_MS),
      // The caller fully handles failure with the fallback below, so a handled
      // timeout must not read as an agent-level error in the log.
      bestEffort: true,
    })
      .then((r) => r.content)
      // Attached here so a late rejection after the race has been decided is
      // never an unhandled rejection.
      .catch((err: unknown) => {
        logger.warn('ask title: the system model did not answer (falling back to the ticket id)', {
          error: err instanceof Error ? err.message : String(err), model: systemModel,
        }, agentId);
        return null;
      });

    // The bound is HERE, not in the provider layer: whatever the adapter does
    // with an abort signal, ingest returns within the bound.
    const raced = await Promise.race([
      answered,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ASK_TITLE_TIMEOUT_MS); }),
    ]);
    return acceptModelTitle(agentId, raced);
  } catch (err) {
    logger.warn('ask title: could not be resolved (falling back to the ticket id)', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── THE INGEST DOOR ─────────────────────────────────────────────────────────
//
// Every channel that carries a person's message writes it through here rather
// than calling the writer directly, for one reason: the ticket that message
// opens needs a title, the title is written by the system model, and the model
// must be asked BEFORE the write opens.
//
// IT LIVES HERE AND NOT IN THE WRITER, and that is a graph fact rather than a
// taste: `memory/message-store.ts` is the SINGLE SYNCHRONOUS WRITER for
// `messages`, and giving it an import of the model layer would point the write
// side at the router. The dependency runs one way — the door reaches for the
// writer, never the reverse — so the writer keeps knowing nothing about models.
//
// The one-transaction invariant is untouched and this is the whole shape of
// why: the ask happens out here, where awaiting is legal; the write is the same
// synchronous `withUnit` it always was, and it now carries the finished title
// in. No interim value is ever written, and `SyncOnly<T>` in `db/unit.ts` still
// compile-refuses an await inside the unit.
//
// A message NEVER waits for a title it does not need: `wouldOpenAsk` is the
// same gate the writer applies inside the unit, so anything that is not a
// person asking this agent for something goes straight through with no model
// call at all.
//
// This never throws for a title's sake. Every failure — no system tier, a slow
// provider, an unusable answer — lands the message with the ticket carrying its
// own identifier. A person's message may not be lost over what it is called.

/**
 * The title this row's ticket will carry, resolved BEFORE any transaction opens.
 * `null` means "the ticket takes its own identifier" — every caller treats it
 * that way and no caller may substitute anything derived from the content.
 *
 * Exported for the one producer that owns an outer transaction of its own
 * (`services/imessage-bridge.ts`: the poll cursor advances with the row). It
 * calls this above its own `db.transaction`, exactly as it already resolves
 * conversation identity there.
 */
export async function resolveInboundAskTitle(m: NewMessage): Promise<string | null> {
  if (!wouldOpenAsk(m)) return null;
  return resolveAskTitle(m.agentId, m.content);
}

/**
 * The door for a message arriving from a person on a channel.
 *
 * Returns `null` when the row was already there (the same designed no-op
 * `insertMessageIfAbsent` returns).
 */
export async function insertInboundMessageIfAbsent(m: NewMessage): Promise<Persisted | null> {
  if (m.askTitle !== undefined) return insertMessageIfAbsent(m);
  const askTitle = await resolveInboundAskTitle(m);
  return insertMessageIfAbsent(askTitle === null ? m : { ...m, askTitle });
}
