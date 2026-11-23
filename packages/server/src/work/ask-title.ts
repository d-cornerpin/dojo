// Ask titles: an ask is filed at once with its own id as the title (`askIdForMessage`, derived from
// the message id) and the system model's title replaces it in the background; nothing waits.
// The id is never a slice of the message, which would copy typed values into `work.title`.
// `acceptModelTitle` refuses (never repairs) a title the declared-value scrub would change.
// Never add a value-shape ("looks like a key") test: the declared-value scrub is the one secrecy check.
// Tested in `memory/__tests__/ask-title-at-ingest.test.ts`.

import { stripInboundChannelMarker } from '@dojo/shared';
import { createLogger } from '../logger.js';
import { redactHandedCredentials } from '../credentials/secret-values.js';
import { withUnit } from '../db/unit.js';
import { getDb } from '../db/connection.js';
import { withSessionBoundary } from '../memory/session-boundary.js';
import { askIdForMessage } from './store.js';
import { patchWork } from './tracker-store.js';
import {
  insertMessageIfAbsent, wouldOpenAsk, type NewMessage, type Persisted,
} from '../memory/message-store.js';

const logger = createLogger('ask-title');

export const ASK_TITLE_MAX_CHARS = 80;

export const ASK_TITLE_INPUT_CHARS = 2000;

/** Total time the title call may take; past it the id beats the answer. */
export const ASK_TITLE_LATENCY_BUDGET_MS = 30_000;

/** The instruction sent to the model. Context-free, so it must name no subject to echo. */
export const TITLE_INSTRUCTION = [
  'Write a short title for the request below.',
  'Rules:',
  '- 3 to 8 words, describing WHAT IS BEING ASKED.',
  '- Never copy values out of the message: no keys, tokens, passwords, account',
  '  numbers, addresses, phone numbers, or quoted text.',
  '- A message that only says thanks or acknowledges something is titled "Thanks".',
  '- Reply with the title only. No quotes, no punctuation at the end, no prose.',
].join('\n');

/** Earlier same-conversation owner messages shown as input; the title still passes the scrub. */
const ASK_TITLE_CONTEXT_MESSAGES = 2;
const ASK_TITLE_CONTEXT_CHARS = 600;
const ASK_TITLE_CONTEXT_PER_MESSAGE = 280;

/** Turn the model's answer into a title, or `null` (the ask keeps its own id). */
export function acceptModelTitle(agentId: string, raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let t = raw.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  t = t.replace(/^title\s*[:\-—]\s*/i, '');
  t = t.replace(/^["'`“”‘’]+/, '').replace(/["'`“”‘’]+$/, '');
  t = t.replace(/\s+/g, ' ').trim();

  // Refuse answers that break the instruction's own rules (over the cap, structured); no truncation.
  const violatesFormat = t.length > ASK_TITLE_MAX_CHARS || t.includes('{') || t.includes('}');
  if (violatesFormat) {
    logger.warn('ask title refused: the model\'s answer does not obey the instruction\'s own '
      + 'format (too long for a 3-8 word title, or structured output rather than prose) — '
      + 'the ticket keeps its own identifier', { agentId, answeredChars: t.length });
    return null;
  }

  if (t.length === 0) {
    logger.warn('ask title: the system model answered with nothing usable '
      + '(the ticket keeps its own identifier)', { agentId, answeredChars: raw.length });
    return null;
  }

  // Refuse the whole title if the declared-value scrub would change it, never the scrubbed form.
  if (redactHandedCredentials(agentId, t) !== t) {
    logger.warn('ask title refused: the model copied a declared secret value into it — '
      + 'the ticket keeps its own identifier as its title', { agentId });
    return null;
  }
  return t;
}

/** Earlier owner messages of this conversation in the current session, oldest first. */
export function priorOwnerContext(agentId: string, conversationId: string | null | undefined, messageId: string): string[] {
  if (!conversationId) return [];
  try {
    const session = withSessionBoundary(agentId);
    const rows = getDb().prepare(
      `SELECT content FROM messages
        WHERE agent_id = ? AND conversation_id = ? AND lane = 'owner' AND role = 'user'
          AND retired_at IS NULL${session.sql}
          AND seq < (SELECT seq FROM messages WHERE id = ?)
        ORDER BY seq DESC LIMIT ?`,
    ).all(agentId, conversationId, ...session.params, messageId, ASK_TITLE_CONTEXT_MESSAGES) as Array<{ content: string | null }>;
    const texts = rows
      .map((r) => stripInboundChannelMarker(r.content ?? '').replace(/\s+/g, ' ').trim())
      .filter((s) => s.length > 0)
      .map((s) => s.slice(0, ASK_TITLE_CONTEXT_PER_MESSAGE))
      .reverse();
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

export function buildTitlePrompt(content: string, priorContext: readonly string[] = []): string {
  if (priorContext.length === 0) return stripInboundChannelMarker(content).slice(0, ASK_TITLE_INPUT_CHARS);
  const block =
    'Earlier in this conversation, for context only — do NOT title these:\n'
    + priorContext.map((s) => `- ${s}`).join('\n')
    + '\n\nThe request to title:\n';
  const room = Math.max(0, ASK_TITLE_INPUT_CHARS - block.length);
  return `${block}${stripInboundChannelMarker(content).slice(0, room)}`;
}

/** Title for this ask, or `null` to keep its id. Never throws. Imports are dynamic to avoid a cycle. */
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
  if (!systemModel) return null;

  try {
    const { callModel } = await import('../agent/model.js');
    // One attempt only: a retry would be a loop nobody waits on, behind a person already answered.
    const r = await callModel({
      agentId,
      modelId: systemModel,
      systemPrompt: TITLE_INSTRUCTION,
      messages: [{ role: 'user', content: buildTitlePrompt(content, priorContext) }],
      tools: false,
      // `utility-dial.ts` keys its thinking-off and output cap off this word alone.
      purpose: 'ask_title',
      // Past the budget the id beats the answer; the abort lands in the catch below as a warn.
      abortSignal: AbortSignal.timeout(ASK_TITLE_LATENCY_BUDGET_MS),
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

/** Replace the title only while it is still the filing id, so a newer rename wins. */
function retitleIfStillUnnamed(workId: string, title: string): boolean {
  return withUnit((): boolean => {
    const row = getDb()
      .prepare("SELECT title FROM work WHERE id = ? AND kind = 'ask'")
      .get(workId) as { title: string | null } | undefined;
    // A missing ask is a background job arriving after the world moved on, not an error.
    if (!row || row.title !== workId) return false;
    return patchWork(workId, { title }).kind === 'applied';
  });
}

/** How many recent asks the re-vet scans (the titler answers within seconds). */
const ASK_TITLE_REVET_SCAN = 50;

/** Restore the id on recent ask titles the scrub would now change; called wherever a declared value may
 *  first be learned (a model call, a credential fetch), and never throws so it cannot cost that caller.
 *  `opened_at` is integer ms, so `withSessionBoundary` (TEXT timestamps) must not be used here. */
export function revetOpenAskTitles(agentId: string): number {
  try {
    const rows = getDb().prepare(
      `SELECT id, title FROM work
        WHERE kind = 'ask' AND agent_id = ? AND title IS NOT NULL AND title <> id
        ORDER BY opened_at DESC LIMIT ?`,
    ).all(agentId, ASK_TITLE_REVET_SCAN) as Array<{ id: string; title: string }>;

    let restored = 0;
    for (const r of rows) {
      // The one redactor as the predicate: an unchanged string holds nothing this agent handled.
      if (redactHandedCredentials(agentId, r.title) === r.title) continue;
      const applied = withUnit(() => patchWork(r.id, { title: r.id }).kind === 'applied');
      if (applied) {
        restored++;
        // Loud on purpose: a model copied a value, recoverable only because it registered later.
        logger.warn('ask title re-vetted after a credential was registered: the model had '
          + 'copied a now-known secret value into it, so the ticket got its own identifier '
          + 'back', { workId: r.id }, agentId);
      }
    }
    return restored;
  } catch (err) {
    logger.warn('ask title re-vet could not run (titles minted this turn keep what they have)', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return 0;
  }
}

// Ingest door: every channel writes a person's message through here so the title is requested
// after the row is durable. It is not in `memory/message-store.ts` (the single synchronous writer),
// so the writer never imports the model layer. A message that opens no ask costs no model call.

/** Name the ask via the system model; fire-and-forget, never throws. Exported for
 *  `services/imessage-bridge.ts`, which calls it after its own transaction commits. */
export async function replaceAskTitleFromModel(m: NewMessage, messageId: string): Promise<void> {
  try {
    if (!wouldOpenAsk(m)) return;
    // Earlier messages of the conversation, so a subject-free follow-up is not named from the instruction's nouns.
    const title = await resolveAskTitle(
      m.agentId, m.content, priorOwnerContext(m.agentId, m.conversationId, messageId),
    );
    // `null` is the designed outcome: the ask keeps the id it was filed with.
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

/** Door for a person's inbound message: synchronous so nothing awaits a title. */
export function insertInboundMessageIfAbsent(m: NewMessage): Persisted | null {
  const persisted = insertMessageIfAbsent(m);
  if (persisted !== null && m.askTitle === undefined) {
    void replaceAskTitleFromModel(m, persisted.id);
  }
  return persisted;
}
