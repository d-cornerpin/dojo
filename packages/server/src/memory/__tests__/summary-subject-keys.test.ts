// ════════════════════════════════════════════════════════════════════════════════════════
// t48 — THE THREE KEYS THAT NAME A NOTE'S CONVERSATION, ON THEIR OWN.
//
// rowSubjectKey / lineageOf / subjectBatches in summary-subject.ts are the pure heart of "which
// conversation a stored message — and so a condensed note — belongs to": get one wrong and two
// conversations merge into one note. They never touch the database module the file imports at the
// top, so this suite names each one directly, measured on v35.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import { rowSubjectKey, lineageOf, subjectBatches, SEVERAL_SUBJECTS } from '../summary-subject.js';

/** A row with the columns the key never reads defaulted off, so a test names only the ones that matter. */
const row = (partial: Omit<Partial<Parameters<typeof rowSubjectKey>[0]>, 'origin'> & { origin?: { kind: string } }): Parameters<typeof rowSubjectKey>[0] =>
  ({ conversationId: null, a2aThreadId: null, sourceAgentId: null, origin: undefined, ...partial }) as Parameters<typeof rowSubjectKey>[0];

describe('rowSubjectKey — a role and its columns, the one conversation key', () => {
  it('a system row has no subject of its own, even with a conversation id', () => {
    expect(rowSubjectKey(row({ role: 'system', conversationId: 'c1' }))).toBeNull();
  });

  it('a user row from another agent or the engine is an a2a thread or the engine', () => {
    expect(rowSubjectKey(row({ role: 'user', sourceAgentId: 'ag1', a2aThreadId: 't1' }))).toBe('a2a:t1');
    expect(rowSubjectKey(row({ role: 'user', origin: { kind: 'agent' } }))).toBe('a2a:');
    expect(rowSubjectKey(row({ role: 'user', origin: { kind: 'engine' } }))).toBe('engine');
  });

  it('a user row: a conversation id is its own key, nothing on record is unknown', () => {
    expect(rowSubjectKey(row({ role: 'user', conversationId: 'c1' }))).toBe('conv:c1');
    expect(rowSubjectKey(row({ role: 'user' }))).toBe('unknown');
  });

  it('an assistant row follows its subjectKind', () => {
    expect(rowSubjectKey(row({ role: 'assistant', subjectKind: 'delivered', conversationId: 'c2' }))).toBe('conv:c2');
    expect(rowSubjectKey(row({ role: 'assistant', subjectKind: 'conv' }))).toBe('unknown');
    expect(rowSubjectKey(row({ role: 'assistant', subjectKind: 'a2a_thread', a2aThreadId: 't9' }))).toBe('a2a:t9');
    expect(rowSubjectKey(row({ role: 'assistant', subjectKind: 'engine_event' }))).toBe('engine');
    expect(rowSubjectKey(row({ role: 'assistant', subjectKind: 'background' }))).toBe('background');
  });

  it('an assistant row with no subjectKind falls back to its columns', () => {
    expect(rowSubjectKey(row({ role: 'assistant', conversationId: 'c3', a2aThreadId: 't3' }))).toBe('conv:c3');
    expect(rowSubjectKey(row({ role: 'assistant', a2aThreadId: 't3' }))).toBe('a2a:t3');
    expect(rowSubjectKey(row({ role: 'assistant' }))).toBe('unknown');
  });
});

describe('lineageOf — the lineage columns read off a key', () => {
  it('a conv key names its conversation, an a2a key names its thread', () => {
    expect(lineageOf('conv:c1')).toEqual({ conversationId: 'c1', a2aThreadId: null });
    expect(lineageOf('a2a:t1')).toEqual({ conversationId: null, a2aThreadId: 't1' });
  });

  it('an empty a2a key, the engine, several, unknown and null name nothing', () => {
    for (const key of ['a2a:', 'engine', SEVERAL_SUBJECTS, 'unknown', null]) {
      expect(lineageOf(key)).toEqual({ conversationId: null, a2aThreadId: null });
    }
  });
});

describe('subjectBatches — the condensation batches', () => {
  const subj = (subjectKey: string, rebuildState?: string): { subjectKey: string; rebuildState?: string } =>
    rebuildState === undefined ? { subjectKey } : { subjectKey, rebuildState };

  it('rows in one conversation cut to the size, conversation by conversation', () => {
    const batches = subjectBatches(['a', 'a', 'a', 'b', 'b'].map((k) => subj(k)), 2).map((b) => b.map((r) => r.subjectKey));
    expect(batches).toEqual([['a', 'a'], ['b', 'b']]);
  });

  it('a lone note is dropped while a bigger batch exists', () => {
    const batches = subjectBatches(['a', 'a', 'b'].map((k) => subj(k)), 5).map((b) => b.map((r) => r.subjectKey));
    expect(batches).toEqual([['a', 'a']]);
  });

  it('no two notes in one conversation: the last resort batches across conversations', () => {
    expect(subjectBatches([subj('a'), subj('b')], 5)).toEqual([[{ subjectKey: 'a' }, { subjectKey: 'b' }]]);
  });

  it('a note queued for rebuild is left out of the last resort', () => {
    expect(subjectBatches([subj('a'), subj('b', 'legacy_mixed_rebuild')], 5)).toEqual([[{ subjectKey: 'a' }]]);
  });

  it('tried notes still count for crossing: a conversation holding four notes, three tried, never crosses to a lone one', () => {
    const rows = [...['a1', 'a2', 'a3', 'a4'].map((id) => ({ id, subjectKey: 'a' })), { id: 'b1', subjectKey: 'b' }];
    const tried = new Set(['a1', 'a2', 'a3']);
    expect(subjectBatches(rows, 2, (r) => !tried.has(r.id)).filter((b) => b.length > 1)).toEqual([]);
  });
});
