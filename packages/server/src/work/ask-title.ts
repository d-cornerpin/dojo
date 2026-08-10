// ════════════════════════════════════════════════════════════════════════════
// WHAT AN ASK TICKET IS CALLED
//   PHASE-5 T9 (the owner's decision D4) — the title is WRITTEN BY THE SYSTEM MODEL.
//   PHASE-6 T0B (the owner, 2026-08-04) — it is ID-FIRST, and the model's title
//   REPLACES it. Nothing waits.
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
//  1. THE TICKET FILES IMMEDIATELY, WITH ITS OWN IDENTIFIER. `insertMessage`'s
//     own header records the one-transaction invariant: the message row and the
//     ticket it opens are ONE unit, both or neither. That is untouched. What
//     changed is what the unit carries: `askIdForMessage()`, derived from the
//     message id and therefore carrying nothing a person typed. **REFUSAL: the
//     initial value is NEVER the 120-character slice** — that is the mechanism
//     being removed, and re-introducing it anywhere on this path re-opens the
//     hole it was removed for.
//     Held by: `insertInboundMessageIfAbsent` below (synchronous — you cannot
//     wait on what is not a promise) and `SyncOnly<T>` in `db/unit.ts`.
//
//  2. THE MODEL'S TITLE REPLACES IT, IN THE BACKGROUND, AND MAY LOSE. The
//     replacement writes ONLY over the identifier the ticket was filed with
//     (`retitleIfStillUnnamed` below). Anything that renamed the ticket in the
//     meantime — an agent, the owner, the PM — is newer than the model's answer
//     and wins. That guard is also what makes this crash-honest: a replacement
//     that never arrives leaves a title that is content-free by construction,
//     there is no retry loop that can spin, and no interim state is orphaned
//     because the "interim" value is the permanent fallback.
//
//  3. AN INSTRUCTION TO A MODEL IS NOT A PROVEN REFUSAL. The prompt asks for a
//     title that copies no values; that request is a request. What makes it a
//     property is `acceptModelTitle()`, which runs the platform's EXISTING
//     declared-value scrub over the model's answer and REFUSES the whole title
//     if the scrub would change it — leaving the ticket's own id standing.
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
// ── THE COST THAT WAS REMOVED, AND THE MEASUREMENT THAT PRICED IT ──
// T9 asked the model BEFORE the write opened and made ingest WAIT for the
// answer under a bounded race (`ASK_TITLE_TIMEOUT_MS = 5000`, `Promise.race`).
// That bound was measured rather than inherited: driven on the box 2026-08-03
// through this exact path (POST /api/chat/kevin/messages, wall clock at the
// caller, system tier = the floor model), NINE samples ran 2296 / 2577 / 2847 /
// 3246 / 3622 / 3670 / 3727 / 4215 / 5198 ms — median 3622, max 5198. So every
// inbound ask paid 2.3–5.2 s before its row landed. The owner read that number
// at the PHASE-5 exit review and directed the flip; PHASE-6 T0B deleted the
// bound and the race in the same change that stopped waiting, and the whole
// cost is now zero — the row lands at once and the title catches up.
//
// The one bound that stays is the LENGTH cap, `OPENER_MAX_CHARS = 80` from the
// voice opener (`voice/voice-ws.ts:1251`), the platform's other short
// model-written string.
//
// NOTHING HERE IS UNBOUNDED BY THE DELETION, and that is measured rather than
// assumed: every provider path in `callModel` carries its own bound that does
// not depend on a caller's signal — the Ollama path a 300 s fetch timeout
// (`agent/model.ts:615`), the OpenAI and Anthropic paths the stream watchdog's
// 90 s first-chunk / 60 s idle abort (`agent/model.ts:55-77`), whose controller
// fires whether or not an external signal was supplied. What was deleted is the
// bound on how long INGEST waits, because ingest no longer waits at all.
// ════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';
import { redactHandedCredentials } from '../credentials/secret-values.js';
import { withUnit } from '../db/unit.js';
import { getDb } from '../db/connection.js';
import { askIdForMessage } from './store.js';
import { patchWork } from './tracker-store.js';
import {
  insertMessageIfAbsent, wouldOpenAsk, type NewMessage, type Persisted,
} from '../memory/message-store.js';

const logger = createLogger('ask-title');

/** The longest title written. */
export const ASK_TITLE_MAX_CHARS = 80;

/**
 * How much of the message the system model is shown. Bounded because this call
 * happens for every inbound ask: a long paste must not turn one message into an
 * expensive request.
 */
export const ASK_TITLE_INPUT_CHARS = 2000;

/**
 * UX-REPAIR T6 — `, for a work tracker` IS GONE FROM THE FIRST LINE, and its
 * absence is the fix.
 *
 * Live on the box, 2026-08-10: *"Add a small section for gym stuff."* came back
 * titled **"Add gym section to work tracker"**. "work tracker" is nowhere in the
 * message. It was in THIS STRING, and the call is context-free by construction
 * (`systemPrompt: ''`, one message, no conversation), so on a subject-free
 * follow-up the only concrete noun the model had to reach for was the
 * instruction's own. The rules below already carry the register the clause was
 * there to set; nothing else about the register is lost.
 *
 * Exported so the test can assert the words are not here, rather than assert
 * about a copy of them.
 */
export const TITLE_INSTRUCTION = [
  'Write a short title for the request below.',
  'Rules:',
  '- 3 to 8 words, describing WHAT IS BEING ASKED.',
  '- Never copy values out of the message: no keys, tokens, passwords, account',
  '  numbers, addresses, phone numbers, or quoted text.',
  '- Reply with the title only. No quotes, no punctuation at the end, no prose.',
].join('\n');

/**
 * How many earlier owner-lane messages of the SAME conversation ride along as
 * context, and the slice of the input budget they may take.
 *
 * WHY THIS IS NOT THE MECHANISM T9 REFUSED, stated here because the refusal is
 * a few lines up and a reader will reach for it: T9 removed a title that WAS a
 * 120-character SLICE of the message — the output was a copy. This is INPUT.
 * The model still writes the title, and the title still passes
 * `acceptModelTitle`'s scrub before anything is written. The current message's
 * own text has always been input to this call; its predecessor is the same kind
 * of thing, and the reason the model needs it is that a follow-up like "add a
 * section for gym stuff" names no subject at all.
 */
const ASK_TITLE_CONTEXT_MESSAGES = 2;
const ASK_TITLE_CONTEXT_CHARS = 600;
const ASK_TITLE_CONTEXT_PER_MESSAGE = 280;

/**
 * THE CHECK (requirement 3). Turn whatever the model said into a title, or
 * refuse it.
 *
 * Returns `null` for "leave the ticket its own identifier" — every caller
 * treats `null` that way and no caller may substitute anything else.
 */
export function acceptModelTitle(agentId: string, raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  // One line, no wrapping quotes, no "Title:" preamble, whitespace collapsed.
  let t = raw.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  t = t.replace(/^title\s*[:\-—]\s*/i, '');
  t = t.replace(/^["'`“”‘’]+/, '').replace(/["'`“”‘’]+$/, '');
  t = t.replace(/\s+/g, ' ').trim();

  // ── UX-REPAIR T6: FORMAT CONFORMANCE, AND WHY IT IS NOT THE REFUSED TEST ──
  //
  // The block below refuses an answer that does not obey THE INSTRUCTION'S OWN
  // STATED RULES ("3 to 8 words", "reply with the title only, no prose"). It is
  // the opposite of the shape-sniffing refused a few lines up: that refusal is
  // about never GUESSING WHAT A VALUE MEANS ("does this look like a key"), and
  // this check never looks at meaning at all. The declared-value scrub below
  // remains the one and only secrecy authority, and it still runs after this.
  //
  // It exists because the scrub was the ONLY check, so a title was validated for
  // secrets and for nothing else. Measured on the box: `ask:4149b755-…` is titled
  // `{"type":"function","function":{"name":"file_write",…` — a raw tool-call blob,
  // accepted. And of the TEN ask rows whose title is exactly ASK_TITLE_MAX_CHARS
  // long — the signature of the truncation this replaces — every one is junk of
  // that kind (tool-call JSON, the model's own monologue, a meta-refusal). Not
  // one is a good title that was merely clipped. So over-length REFUSES now
  // rather than truncating: an answer longer than the cap is an answer that
  // ignored "3 to 8 words", and the ticket's own identifier is the better name.
  //
  // A newline is NOT listed here: the first-line extraction above already
  // handles that case, and handles it better than a refusal would ("Check the
  // invoice\nand also some prose" still yields a usable title).
  const violatesFormat = t.length > ASK_TITLE_MAX_CHARS || t.includes('{') || t.includes('}');
  if (violatesFormat) {
    logger.warn('ask title refused: the model\'s answer does not obey the instruction\'s own '
      + 'format (too long for a 3-8 word title, or structured output rather than prose) — '
      + 'the ticket keeps its own identifier', { agentId, answeredChars: t.length });
    return null;
  }

  if (t.length === 0) {
    // Observed on the box: a system model can answer with nothing at all. The
    // fallback is correct and the ticket is fine — but a fallback nobody can see
    // is a mechanism that can rot in silence, so it says so.
    logger.warn('ask title: the system model answered with nothing usable '
      + '(the ticket keeps its own identifier)', { agentId, answeredChars: raw.length });
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
 * Ask the system model for this ask's title. `null` means "leave the ticket its
 * own identifier".
 *
 * Never throws: this runs behind a message that has already landed, and a
 * failure to name a ticket may never become anything louder than a log line.
 *
 * The two imports are dynamic for the reason the other two system-model callers
 * are (`agent/v2/classifiers/multistep.ts:280`, `voice/voice-ws.ts:1270`): the
 * model module reaches back into the message store, so a static import here is
 * a cycle.
 */
/**
 * The earlier owner-lane messages of this conversation, oldest first, or `[]`.
 *
 * Read-only, bounded, and never throws: a title is a nicety and a database that
 * cannot answer this question must not cost the caller anything. Scoped by
 * conversation AND lane AND role, so agent traffic and other threads can never
 * leak into the naming of this ticket, and by `seq` so only messages that
 * genuinely came BEFORE this one are shown.
 */
function priorOwnerContext(agentId: string, conversationId: string | null | undefined, messageId: string): string[] {
  if (!conversationId) return [];
  try {
    const rows = getDb().prepare(
      `SELECT content FROM messages
        WHERE agent_id = ? AND conversation_id = ? AND lane = 'owner' AND role = 'user'
          AND retired_at IS NULL
          AND seq < (SELECT seq FROM messages WHERE id = ?)
        ORDER BY seq DESC LIMIT ?`,
    ).all(agentId, conversationId, messageId, ASK_TITLE_CONTEXT_MESSAGES) as Array<{ content: string | null }>;
    const texts = rows
      .map((r) => (r.content ?? '').replace(/\s+/g, ' ').trim())
      .filter((s) => s.length > 0)
      .map((s) => s.slice(0, ASK_TITLE_CONTEXT_PER_MESSAGE))
      .reverse();
    // The block's own bound, independent of the per-message one.
    const kept: string[] = [];
    let used = 0;
    for (const s of texts) {
      if (used + s.length > ASK_TITLE_CONTEXT_CHARS) break;
      kept.push(s);
      used += s.length;
    }
    return kept;
  } catch {
    return [];
  }
}

/** The exact string the system model is shown. One place, so the test can read
 *  the same bytes the provider gets. */
export function buildTitlePrompt(content: string, priorContext: readonly string[] = []): string {
  if (priorContext.length === 0) {
    return `${TITLE_INSTRUCTION}\n\n${content.slice(0, ASK_TITLE_INPUT_CHARS)}`;
  }
  const block =
    'Earlier in this conversation, for context only — do NOT title these:\n'
    + priorContext.map((s) => `- ${s}`).join('\n')
    + '\n\nThe request to title:\n';
  const room = Math.max(0, ASK_TITLE_INPUT_CHARS - block.length);
  return `${TITLE_INSTRUCTION}\n\n${block}${content.slice(0, room)}`;
}

export async function resolveAskTitle(
  agentId: string,
  content: string,
  priorContext: readonly string[] = [],
): Promise<string | null> {
  if (!agentId || typeof content !== 'string' || content.trim().length === 0) return null;

  let systemModel: string | null = null;
  try {
    const { getSystemModel } = await import('../router/selector.js');
    systemModel = getSystemModel();
  } catch (err) {
    logger.warn('ask title: the system tier could not be read (the ticket keeps its own identifier)', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return null;
  }
  // No system tier configured is a legitimate, supported state — the ticket
  // keeps its own identifier and nothing about ingest changes.
  if (!systemModel) return null;

  try {
    const { callModel } = await import('../agent/model.js');
    // ONE attempt. A retry here would be a loop nobody is waiting on, running
    // behind a person who has already been answered — see requirement 2.
    const r = await callModel({
      agentId,
      modelId: systemModel,
      systemPrompt: '',
      messages: [{ role: 'user', content: buildTitlePrompt(content, priorContext) }],
      tools: false,
      // The caller fully handles failure with the id title, so a handled
      // failure must not read as an agent-level error in the log.
      bestEffort: true,
    });
    return acceptModelTitle(agentId, r.content);
  } catch (err) {
    logger.warn('ask title: the system model did not answer (the ticket keeps its own identifier)', {
      error: err instanceof Error ? err.message : String(err), model: systemModel,
    }, agentId);
    return null;
  }
}

/**
 * The replacement write. It may only write over the identifier the ticket was
 * FILED with, which is the ask's own id.
 *
 * Anything else in that column is newer than this answer — an agent's edit, the
 * owner's, the PM's rename — and a background job that arrived late may not
 * overwrite it. The read and the write are one unit, so nothing can slip
 * between them.
 *
 * Returns true when the title actually landed.
 */
function retitleIfStillUnnamed(workId: string, title: string): boolean {
  return withUnit((): boolean => {
    const row = getDb()
      .prepare("SELECT title FROM work WHERE id = ? AND kind = 'ask'")
      .get(workId) as { title: string | null } | undefined;
    // A ticket that is not there (never opened, or already deleted) is not an
    // error — it is a background job arriving after the world moved on.
    if (!row || row.title !== workId) return false;
    return patchWork(workId, { title }).kind === 'applied';
  });
}

// ── THE INGEST DOOR ─────────────────────────────────────────────────────────
//
// Every channel that carries a person's message writes it through here rather
// than calling the writer directly, for one reason: the ticket that message
// opens is filed with its own identifier and then needs a real title, and the
// system model is asked for that title AFTER the row is durable.
//
// IT LIVES HERE AND NOT IN THE WRITER, and that is a graph fact rather than a
// taste: `memory/message-store.ts` is the SINGLE SYNCHRONOUS WRITER for
// `messages`, and giving it an import of the model layer would point the write
// side at the router. The dependency runs one way — the door reaches for the
// writer, never the reverse — so the writer keeps knowing nothing about models.
//
// The one-transaction invariant is untouched: the write is the same synchronous
// `withUnit` it always was, and `SyncOnly<T>` in `db/unit.ts` still compile-
// refuses an await inside the unit.
//
// A message NEVER costs a model call it does not need: `wouldOpenAsk` is the
// same gate the writer applies inside the unit, so anything that is not a
// person asking this agent for something goes through with no model call at
// all — and a duplicate arrival buys none either, because the writer's designed
// no-op returns `null` and a null row starts nothing.

/**
 * Ask the system model to name this ask's ticket, and write the answer over the
 * identifier the ticket was filed with. Fire-and-forget: production never awaits
 * it, which is the entire point of the flip.
 *
 * Never throws — a rejected promise nobody is holding is an unhandled rejection,
 * and every failure inside is already a fallback that has been chosen.
 *
 * Exported for the one producer that owns an outer transaction of its own
 * (`services/imessage-bridge.ts`: the poll cursor advances with the row). It
 * calls this AFTER its transaction commits.
 */
export async function replaceAskTitleFromModel(m: NewMessage, messageId: string): Promise<void> {
  try {
    if (!wouldOpenAsk(m)) return;
    // UX-REPAIR T6: the conversation the ticket belongs to, so a subject-free
    // follow-up is not named from the instruction's own nouns. Gathered here,
    // where the conversation id and the durable message id both already are.
    const title = await resolveAskTitle(
      m.agentId, m.content, priorOwnerContext(m.agentId, m.conversationId, messageId),
    );
    // `null` is the designed outcome, not a failure: the ticket keeps the
    // content-free identifier it was filed with.
    if (title === null) return;
    const workId = askIdForMessage(messageId);
    if (!retitleIfStillUnnamed(workId, title)) {
      logger.info('ask title: the ticket was renamed before the model answered, so the '
        + 'later name stands', { workId }, m.agentId);
    }
  } catch (err) {
    logger.warn('ask title: the replacement could not be written (the ticket keeps its own '
      + 'identifier)', { error: err instanceof Error ? err.message : String(err) }, m.agentId);
  }
}

/**
 * The door for a message arriving from a person on a channel.
 *
 * SYNCHRONOUS on purpose: nothing waits for a title any more, and a signature
 * that cannot be awaited is how that is held rather than remembered.
 *
 * Returns `null` when the row was already there (the same designed no-op
 * `insertMessageIfAbsent` returns).
 */
export function insertInboundMessageIfAbsent(m: NewMessage): Persisted | null {
  const persisted = insertMessageIfAbsent(m);
  // A caller that brought its own title is honoured and asks no model.
  if (persisted !== null && m.askTitle === undefined) {
    void replaceAskTitleFromModel(m, persisted.id);
  }
  return persisted;
}
