// ── PHASE-2 T7: the two surfaces the deleted open-loops module owned, on the spine ──
//
// `memory/open-loops.ts` was 623 lines, and roughly a third of them were the two RENDERERS
// below. The rest was the machinery that had to exist because the rows were recovered from
// prose: a fenced-section walker, a RESOLVED/CLOSED regex, a Jaccard/coverage similarity
// function used for both dedup and resolution, a party-label attribution map, and a regex
// guard defending the whole arrangement against one known false belief.
//
// None of that survives, because none of it is needed once the row is created when the
// obligation is made (requirement 4a). What IS needed is what the model and the owner
// actually saw, and both are carried across property for property:
//
//   * the per-turn OPEN WORK block — current conversation first, a capped cross-conversation
//     overflow labelled by party, a character budget so a backlog cannot eat the volatile
//     lane on a floor model, and the id the model needs to close a row;
//   * the daily-brief section for AGED obligations — which is where an aged row goes instead
//     of the per-turn lane (4b: ageing demotes, it never closes).
//
// THIS FILE ONLY READS. `work` has exactly one writer, `work/store.ts`, and its conformance
// allowlist is EMPTY (`work/__tests__/single-writer-conformance.test.ts` PART A). The deleted
// module's daily-brief path violated the equivalent rule by design: `markStaleLoops` was an
// UPDATE fired from inside a report generator.

import { getOwnerName } from '../config/platform.js';
import { agedObligations, openObligations, type Obligation } from './store.js';

/** Injection budget: cap the whole block so it never crowds the volatile lane on a floor
 *  model. Carried verbatim from the deleted `INJECTION_MAX_CHARS = 600`. */
const INJECTION_MAX_CHARS = 600;

/** Cross-conversation overflow shown on a turn, beyond the current conversation's own rows.
 *  Carried verbatim from the deleted `CROSS_CONV_OVERFLOW_MAX = 3`. */
const CROSS_CONV_OVERFLOW_MAX = 3;

function relativeAge(openedAtMs: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - openedAtMs) / 1000));
  if (sec < 60) return 'just now';
  const mins = Math.floor(sec / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * Who the obligation belongs to, for the block's party tag.
 *
 * Read from the CONVERSATION ROW's identity columns, not by string-parsing a `conv_key`. The
 * deleted module parsed the key, which is the same column that carried the claim token and the
 * park sigils — so a parked row silently changed the party its loops were attributed to. This
 * is the same information, taken from the place Phase 1 built to hold it.
 */
function party(o: Obligation): string {
  if (!o.conversationId || !o.channel) return 'unattributed';
  if (o.channel === 'a2a') return o.counterpartyName ?? 'an agent thread';
  if (o.channel === 'dashboard' || o.counterpartyId === 'owner') return getOwnerName();
  const who = o.counterpartyName ?? o.counterpartyId;
  return who ? `${who} (${o.channel})` : o.channel;
}

function split(agentId: string, currentConversationId: string | null): { current: Obligation[]; other: Obligation[] } {
  const rows = openObligations(agentId);
  const current: Obligation[] = [];
  const other: Obligation[] = [];
  for (const r of rows) {
    if (currentConversationId && r.conversationId === currentConversationId) current.push(r);
    else other.push(r);
  }
  return { current, other: other.slice(0, CROSS_CONV_OVERFLOW_MAX) };
}

/**
 * The compact numbered OPEN WORK block for the volatile lane, or null when nothing is owed.
 *
 * Keyed on `conversation_id` rather than on a `conv_key` string — the deleted block compared
 * conv_key values, which is the column that also carried the claim/park sigils, so a parked
 * row silently changed which conversation its loops belonged to.
 */
export function buildOpenWorkInjection(agentId: string, currentConversationId: string | null): string | null {
  const { current, other } = split(agentId, currentConversationId);
  if (current.length === 0 && other.length === 0) return null;

  let n = 1;
  const render = (o: Obligation, crossConv: boolean): string => {
    const what = o.kind === 'ask' ? 'they asked' : 'you promised';
    const marker = crossConv ? ' [other conversation]' : '';
    return `${n++}. [${o.id}] ${what}: ${o.title ?? '(no description)'} (${party(o)}, ${relativeAge(o.openedAt)})${marker}`;
  };

  let block = 'OPEN WORK (still owed; close each one when it is delivered):';
  for (const line of [...current.map((o) => render(o, false)), ...other.map((o) => render(o, true))]) {
    if (block.length + 1 + line.length > INJECTION_MAX_CHARS) {
      block += '\n…';
      break;
    }
    block += `\n${line}`;
  }
  return block;
}

/**
 * One line per aged obligation for the daily brief, or null when none have aged.
 *
 * This is a pure read. The mechanism it replaces flipped rows to `status='stale'` from inside
 * the brief generator and then listed what it had just written — so the report decided the
 * data. Here the report reads `opened_at` and changes nothing.
 */
export function buildAgedWorkBriefSection(agentId: string): string | null {
  const aged = agedObligations(agentId);
  if (aged.length === 0) return null;
  const lines = aged.map((o) => {
    const who = party(o);
    const suffix = who === 'unattributed' ? '' : ` (${who})`;
    return `- Still open, no answer: ${o.title ?? '(no description)'}${suffix}, ask again or drop?`;
  });
  return `Open work with no answer:\n${lines.join('\n')}`;
}
