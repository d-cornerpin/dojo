// What the owner is told when a delegation does not come back: which of the three things
// actually happened. `failed` means a peer replied FAIL, a contentless `done` means an
// empty reply, never answered means nothing came back; the notice must never claim a
// reply the peers did not send, and must name who, what and how long it waited.

import { getDb } from '../db/connection.js';
import type { JoinPiece } from '../work/store.js';

const NO_ANSWER_STATES = new Set(['abandoned', 'open', 'claimed', 'blocked']);

export interface PieceTally {
  /** A peer replied FAIL: something came back and it was a refusal. */
  refused: number;
  empty: number;
  silent: number;
}

export function tallyPieces(pieces: readonly JoinPiece[]): PieceTally {
  const t: PieceTally = { refused: 0, empty: 0, silent: 0 };
  for (const p of pieces) {
    if (p.state === 'failed') t.refused += 1;
    else if (NO_ANSWER_STATES.has(p.state)) t.silent += 1;
    else t.empty += 1;              // `done` (or any other terminal) with nothing usable in it
  }
  return t;
}

/** The reason recorded on the work row must match what happened: the audit trail is what a
 *  later session reconstructs the incident from, not the loosest description available. */
export function joinFailureReason(pieces: readonly JoinPiece[]): string {
  const t = tallyPieces(pieces);
  const parts: string[] = [];
  if (t.silent > 0) parts.push(`${t.silent} never answered`);
  if (t.refused > 0) parts.push(`${t.refused} replied FAIL`);
  if (t.empty > 0) parts.push(`${t.empty} replied with nothing usable`);
  return parts.length > 0
    ? `the delegated work produced no answer (${parts.join(', ')})`
    : 'the delegated work produced no answer';
}

/** Rounded, and in the unit a person thinks in. `null` when there is nothing honest to say. */
function waitedFor(openedAtMs: number | null): string | null {
  if (openedAtMs == null || !Number.isFinite(openedAtMs)) return null;
  const secs = Math.max(0, Math.round((Date.now() - openedAtMs) / 1000));
  if (secs < 90) return `${secs} seconds`;
  const mins = Math.round(secs / 60);
  return mins < 90 ? `${mins} minute${mins === 1 ? '' : 's'}` : `${Math.round(mins / 60)} hours`;
}

export function joinOpenedAt(parentWorkId: string): number | null {
  try {
    const row = getDb().prepare(
      'SELECT MIN(opened_at) AS at FROM work WHERE parent_id = ?',
    ).get(parentWorkId) as { at: number | null } | undefined;
    return row?.at ?? null;
  } catch {
    return null;
  }
}

export interface NoticeInput {
  parentWorkId: string;
  pieces: readonly JoinPiece[];
  /** Display names, already resolved by the caller: this module does no name lookup. */
  names: readonly string[];
  questionSnippet: string;
}

/** THE OWNER-FACING SENTENCE: who, what, how long, and which failure happened rather than
 *  all three; the lead leads with silence when any piece is silent. No retry offer: the ask
 *  is already terminal here, so "ask again" is a claim nothing here could honour. */
export function joinFailureNotice(p: NoticeInput): string {
  const t = tallyPieces(p.pieces);
  const who = p.names.length === 0 ? 'another agent'
    : p.names.length === 1 ? p.names[0]
      : `${p.names.slice(0, -1).join(', ')} and ${p.names[p.names.length - 1]}`;
  const waited = waitedFor(joinOpenedAt(p.parentWorkId));
  const plural = p.pieces.length > 1;

  // The negation is spelled out in every arity: never re-factor it into a shared suffix, a
  // shared suffix lets one arity lose the "never" and reads "they answered" for a silent delegate.
  const lead = t.silent > 0 && t.refused === 0 && t.empty === 0
    ? `your agent delegated ${plural ? 'parts of this' : 'this'} to ${who}`
      + `${waited ? ` and waited ${waited}` : ''}, and `
      + `${plural ? 'none of them answered' : 'they never answered'}. `
      + `The ${plural ? 'messages were' : 'message was'} delivered, nothing errored, `
      + `so the platform stopped waiting rather than leaving you in silence.`
    : t.silent > 0
      ? `your agent delegated ${plural ? 'parts of this' : 'this'} to ${who}`
        + `${waited ? ` and waited ${waited}` : ''}: `
        + `${joinFailureReason(p.pieces).replace('the delegated work produced no answer ', '')}.`
      : `your agent asked ${who} about this`
        + `${waited ? `, waited ${waited},` : ''} and got no usable answer back `
        + `(${joinFailureReason(p.pieces).replace('the delegated work produced no answer (', '').replace(/\)$/, '')}).`;

  return lead + (p.questionSnippet ? ` (Your question was: "${p.questionSnippet}")` : '');
}
