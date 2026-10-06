// ════════════════════════════════════════════════════════════════════════════
// WHEN A MODEL'S WINDOW CANNOT HOLD A CONVERSATION, THE PERSON IS TOLD.
//
// ── WHAT THE ENGINE ALREADY DID, AND WHY IT WAS NOT ENOUGH ──
//
// `budget.ts`'s `assertSystemPromptFits` throws `SystemPromptTooLargeError` when an agent's
// system prompt is larger than everything its model's window has left after the tool and output
// reserve. That refusal is correct and it is LOUD — it names the window, the assembly budget,
// the reserve and the three possible repairs — and it was deliberately kept rather than softened
// (t109 §D deleted a second log line as unreachable duplication).
//
// But it is loud in the LOG. The person whose agent will not hold a conversation sees an agent
// that answers with no memory of anything, and nothing anywhere tells them why or what to do.
// t109 measured the shape precisely: on a 16K-window box the tool and output reserve is about
// 14,605 tokens, leaving an assembly budget of 755 against a system prompt of roughly 6,093. The
// reserve scaling t109 built fixes the small-window-with-a-MODEST-tool-surface case; a small
// window with the WHOLE tool surface still lands here, and t109 handed the card up as the
// owner's call because nagging a person about a box they chose is a policy question.
//
// Ruled (orchestrator, from the owner's standing honest-UI rules): build it. This is that card.
//
// ── THE SHAPE, AND WHAT IS BORROWED FROM `compaction-defect.ts` ──
//
// No new channel. The same `chat:error` broadcast every other engine card already rides, which
// the dashboard renders by SEVERITY and not by code — so this needs nothing registered at the
// far end, and `severity: 'error'` means the card stays until the person dismisses it.
//
// Three disciplines are copied from the compaction card on purpose, because they are what make a
// card worth reading:
//   · ONE OUTAGE, ONE CARD. Assembly runs every turn, so the naive form is a toast per turn,
//     which is how a person learns to ignore toasts.
//   · THE LOG LINE IS PER OCCURRENCE. It is the repair audience's record, not the person's
//     toast, and spacing it would silence the box that needs looking at.
//   · `retryable: false`, and nothing destructive is suggested. This does NOT resolve itself:
//     somebody has to change the tool list or the model. Saying "it will recover" would be the
//     comfortable lie — and the card must never ask a person to archive or reset to make room,
//     which is the instruction the owner abolished.
//
// ⚠ AND IT NEVER TELLS THEM TO FIX THE SYSTEM PROMPT. That is the third repair in the engine's
// own error message and it is the one a person cannot act on: the prompt is the agent's soul and
// the platform's own rules. The two repairs on the card are the two they own — the tool list and
// the model.
// ════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import type { ContextWindowPolicy } from './budget.js';

const logger = createLogger('window-starvation');

/** The agents currently known to be starved, so the card fires once per outage. */
const starved = new Map<string, { since: string; systemPromptTokens: number }>();

/**
 * THE CARD, in the person's words rather than the engine's.
 *
 * It leads with whichever cause is actually the bigger share of the window, because telling
 * someone to trim tools when the reserve is a small slice would send them at the wrong thing.
 * Both repairs are always named — a card that offers one option when there are two is a card
 * that makes the other one invisible.
 *
 * Exported so the clause can read the sentence rather than re-type it.
 */
export function starvedWindowCardText(policy: ContextWindowPolicy): string {
  const usable = Math.max(1, Math.floor(policy.compactionThreshold * policy.contextWindow));
  const reserveIsTheProblem = policy.toolAndOutputReserve > usable / 2;
  const lead = reserveIsTheProblem
    ? 'the tools it has been given take up more of that window than its own instructions can fit beside'
    : 'its own instructions do not fit in that window at all';
  return `This agent cannot hold a conversation: its model's memory window is too small — ${lead}. `
    + 'Nothing has been lost, and nothing here needs deleting. '
    + 'Two things fix it: give this agent a shorter tool list, or point it at a model with a '
    + 'bigger context window. It will not start working on its own until one of those changes.';
}

/**
 * Say it, once per outage, to both audiences.
 *
 * Called from the one place that knows an agent just failed this way (`memory/assembler.ts`,
 * around `assertSystemPromptFits`). Returns true when THIS call is the one that carded, so a
 * caller — and the clause — can tell a new outage from a continuing one.
 */
export function reportStarvedWindow(
  agentId: string,
  systemPromptTokens: number,
  policy: ContextWindowPolicy,
): boolean {
  // Per occurrence, deliberately: this is the record for whoever looks at the box.
  logger.error('WINDOW_STARVED the system prompt does not fit this model\'s window', {
    systemPromptTokens,
    assemblyBudgetTokens: policy.assemblyBudgetTokens,
    contextWindow: policy.contextWindow,
    toolAndOutputReserve: policy.toolAndOutputReserve,
    compactionThreshold: policy.compactionThreshold,
    alreadyCarded: starved.has(agentId),
  }, agentId);

  if (starved.has(agentId)) return false;
  starved.set(agentId, { since: new Date().toISOString(), systemPromptTokens });
  try {
    broadcast({
      type: 'chat:error',
      agentId,
      error: starvedWindowCardText(policy),
      code: 'WINDOW_TOO_SMALL',
      severity: 'error',
      // FALSE, and that is the honest value. Unlike a provider outage or a summary writer
      // coming back, nothing about this clears itself: the tool list or the model has to
      // change. A `true` here would promise a recovery that cannot happen.
      retryable: false,
    });
  } catch { /* best effort — the log line is the record, the card is the courtesy */ }
  return true;
}

/**
 * An assembly fit. If this agent was starved, the configuration changed and it is working
 * again — forget the note so a FUTURE outage cards again, and say out loud that nothing had to
 * be clicked to recover.
 *
 * This is the half that makes "once per outage" mean per OUTAGE rather than once per process.
 */
export function noteWindowHolds(agentId: string): void {
  const was = starved.get(agentId);
  if (!was) return;
  starved.delete(agentId);
  logger.info('This agent\'s window holds its prompt again — the configuration changed', {
    wasStarvedSince: was.since, wasSystemPromptTokens: was.systemPromptTokens,
  }, agentId);
}

/** Is this agent currently known to be starved? For a surface that wants to ask. */
export function windowIsStarved(agentId: string): boolean {
  return starved.has(agentId);
}

/** Test-only reset; the map is per-process. */
export function __resetStarvedWindowsForTests(): void {
  starved.clear();
}
