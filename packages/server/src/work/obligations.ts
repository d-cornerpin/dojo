// Read-only renderers over the work spine: the per-turn OPEN WORK block and the daily-brief
// section for aged obligations. Nothing here writes; `work.state` moves only in work/store.ts.

import { a2aThreadShort } from '@dojo/shared';
import { getOwnerName } from '../config/platform.js';
import { agedObligations, isTerminal, joinPieces, openObligations, type Obligation } from './store.js';
import { recordedInstant } from '../memory/message-stamp.js';
import { resolveAgentDisplayName } from '../agent/tool-helpers.js';

/** Character budget for the whole block, so a backlog cannot crowd the volatile lane. */
const INJECTION_MAX_CHARS = 600;

const CROSS_CONV_OVERFLOW_MAX = 3;

// Rows are stamped with their recorded instant, not a relative age, so identical rows render
// identical bytes. Rows still leave the block at the ageing cutoff and demote to the daily brief.
function openedStamp(openedAtMs: number): string {
  return recordedInstant(openedAtMs);
}

/** Who the obligation belongs to, from the conversation row, never by parsing `conv_key`. */
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

/** The helpers a delegated ask still waits on, from its open pieces; empty when it waits on none. */
function waitingOn(o: Obligation): string {
  const open = o.kind === 'ask' ? joinPieces(o.id).filter((p) => !isTerminal(p.state)) : [];
  const who = open.map((p) => `${resolveAgentDisplayName(p.assigneeAgent) ?? 'a helper'} (thread ${a2aThreadShort(p.threadId)})`);
  return who.length > 0 ? ` waiting on ${who.join(', ')}` : '';
}

const HEADER = 'OPEN WORK (still owed; close each one when it is delivered):';

// When the budget binds, rows give way in a declared order (cross-conversation overflow, then the oldest
// current rows) so the row the running turn just made survives. It rides the volatile tail
// (`engine.open-work`), never the cached prompt prefix.
export function buildOpenWorkInjection(agentId: string, currentConversationId: string | null): string | null {
  const { current, other } = split(agentId, currentConversationId);
  if (current.length === 0 && other.length === 0) return null;

  const what = (o: Obligation): string => (o.kind === 'ask' ? 'they asked' : 'you promised');
  const body = (o: Obligation, crossConv: boolean): string =>
    `[${o.id}] ${what(o)}: ${o.title ?? '(no description)'} (${party(o)}, opened ${openedStamp(o.openedAt)})${waitingOn(o)}${crossConv ? ' [other conversation]' : ''}`;

  const shown = [
    ...current.map((o) => ({ o, crossConv: false })),
    ...other.map((o) => ({ o, crossConv: true })),
  ];
  const dropOrder = [
    ...other.map((o) => ({ o, crossConv: true })),
    ...current.map((o) => ({ o, crossConv: false })),
  ];

  const kept = new Set(shown);
  const byRow = new Map(shown.map((e) => [e.o, e]));
  const lengthOf = (entries: Array<{ o: Obligation; crossConv: boolean }>): number =>
    entries.reduce((sum, e, i) => sum + 1 + `${i + 1}. `.length + body(e.o, e.crossConv).length, HEADER.length);

  let dropped = 0;
  for (const e of dropOrder) {
    if (lengthOf(shown.filter((x) => kept.has(x))) <= INJECTION_MAX_CHARS) break;
    // The newest current row is the one the running turn just made, so it is never given away.
    if (kept.size === 1) break;
    kept.delete(byRow.get(e.o)!);
    dropped += 1;
  }

  let n = 1;
  const lines = shown.filter((e) => kept.has(e)).map((e) => {
    const prefix = `${n++}. `;
    const text = body(e.o, e.crossConv);
    // An over-budget row is abbreviated, never dropped: the id needed to close it comes first.
    const room = INJECTION_MAX_CHARS - HEADER.length - 1 - prefix.length;
    return prefix + (text.length > room && room > 1 ? `${text.slice(0, room - 1)}…` : text);
  });

  const tail = dropped > 0 ? `\n… and ${dropped} more open item${dropped === 1 ? '' : 's'} not shown` : '';
  return `${HEADER}\n${lines.join('\n')}${tail}`;
}

/** One line per aged obligation for the daily brief, or null; a pure read, it never flips rows. */
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
