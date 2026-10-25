// v3.5 B2 — THE DECISION SHADOW LOG AND THE PER-QUESTION SCORE. What the rule said, what the model
// said, and (later, from the ledger) what really happened; scored per question with Wilson 95 %
// intervals. REVIEW FOCUS 4: on a busy box the log is bounded the way the log file is.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));

import { runMigrations } from '../../db/migrations.js';
import { recordShadow, recordTruth, scoreQuestion, rotateDecisionShadow, SHADOW_REPORT_WINDOW_MS, __resetShadowRotationForTests } from '../decision-shadow.js';
import type { Answer } from '../decide.js';

const db = (): Database.Database => mockDb.current!;
const noul = (p: number): Answer => ({ type: 'noul', noul: p });
beforeEach(() => { mockDb.current = new Database(':memory:'); runMigrations(mockDb.current); __resetShadowRotationForTests(); });
afterEach(() => { vi.useRealTimers(); mockDb.current?.close(); mockDb.current = null; });

describe('recordShadow / recordTruth', () => {
  it('the truth joins by turn AND question', () => {
    const a = recordShadow({ purpose: 'reply_claims', question: 'claims_saved', turnId: 't1', ruleSaid: true, modelSaid: noul(0.8) });
    const b = recordShadow({ purpose: 'reply_claims', question: 'claims_sent', turnId: 't1', ruleSaid: false, modelSaid: noul(0.1) });
    const c = recordShadow({ purpose: 'reply_claims', question: 'claims_saved', turnId: 't2', ruleSaid: true, modelSaid: null });
    expect(new Set([a, b, c]).size).toBe(3);
    recordTruth('t1', 'claims_saved', false, 'work_rows');
    const rows = db().prepare('SELECT id, truth, truth_src, truth_at FROM decision_shadow ORDER BY id').all() as Array<{ id: number; truth: string | null; truth_src: string | null; truth_at: number | null }>;
    expect(rows[0]).toMatchObject({ id: a, truth: 'false', truth_src: 'work_rows' });
    expect(typeof rows[0].truth_at).toBe('number');
    expect(rows[1].truth).toBeNull();
    expect(rows[2].truth).toBeNull();
  });
});

describe('scoreQuestion — a hand-computed case', () => {
  it('10 judged turns: the rule right 6 times, the model right 8; Wilson 95 % intervals; the weakest band', () => {
    // truth is `true` on every turn. The rule said true on 6. The model was sure and right on 8
    // (p 0.9) and unsure and wrong on 2 (p 0.45 and 0.42, so it said false).
    for (let i = 0; i < 10; i++) {
      const turn = `turn-${i}`;
      recordShadow({ purpose: 'p', question: 'q', turnId: turn, ruleSaid: i < 6, modelSaid: noul(i < 8 ? 0.9 : i === 8 ? 0.45 : 0.42) });
      recordTruth(turn, 'q', true, 'ledger');
    }
    // Not judged: no truth yet, or no model answer (decide() returned null). Neither counts.
    recordShadow({ purpose: 'p', question: 'q', turnId: 'open', ruleSaid: true, modelSaid: noul(0.9) });
    recordShadow({ purpose: 'p', question: 'q', turnId: 'down', ruleSaid: true, modelSaid: null });
    recordTruth('down', 'q', true, 'ledger');

    const s = scoreQuestion('p', 'q')!;
    expect(s.n).toBe(10);
    expect(s.ruleAcc).toBeCloseTo(0.6, 10);
    expect(s.modelAcc).toBeCloseTo(0.8, 10);
    // Wilson, z = 1.96, by hand: 6/10 → [0.31267, 0.83183]; 8/10 → [0.49016, 0.94332].
    expect(s.ruleCI[0]).toBeCloseTo(0.31267, 4);
    expect(s.ruleCI[1]).toBeCloseTo(0.83183, 4);
    expect(s.modelCI[0]).toBeCloseTo(0.49016, 4);
    expect(s.modelCI[1]).toBeCloseTo(0.94332, 4);
    expect(s.band).toEqual([0.4, 0.5]);
  });

  it('no judged rows → null', () => {
    recordShadow({ purpose: 'p', question: 'q', turnId: 't', ruleSaid: true, modelSaid: noul(0.9) });
    expect(scoreQuestion('p', 'q')).toBeNull();
  });

  it('a choice question is right when its choice is the truth', () => {
    recordShadow({ purpose: 'p', question: 'topic', turnId: 't', ruleSaid: 'other', modelSaid: { type: 'choice', choice: 'billing', probabilities: { billing: 0.8, other: 0.2 }, confidence: 0.6 } });
    recordTruth('t', 'topic', 'billing', 'ledger');
    expect(scoreQuestion('p', 'topic')).toMatchObject({ n: 1, ruleAcc: 0, modelAcc: 1 });
  });
});

describe('REVIEW FOCUS 4: the log is bounded like the log file (the live window and one before it)', () => {
  it('rotation drops rows older than two report windows and keeps the rest', () => {
    const now = Date.UTC(2026, 9, 23);
    const old = now - 2 * SHADOW_REPORT_WINDOW_MS - 1;
    const kept = now - 2 * SHADOW_REPORT_WINDOW_MS + 60_000;
    const ins = db().prepare("INSERT INTO decision_shadow (purpose, question, rule_said, created_at) VALUES ('p', 'q', 'true', ?)");
    ins.run(old); ins.run(kept); ins.run(now);
    expect(rotateDecisionShadow(now)).toBe(1);
    expect((db().prepare('SELECT created_at FROM decision_shadow ORDER BY created_at').all() as Array<{ created_at: number }>).map((r) => r.created_at)).toEqual([kept, now]);
  });

  it('recording a row rotates on the way in', () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 23), toFake: ['Date'] });
    db().prepare("INSERT INTO decision_shadow (purpose, question, rule_said, created_at) VALUES ('p', 'q', 'true', ?)").run(Date.now() - 3 * SHADOW_REPORT_WINDOW_MS);
    recordShadow({ purpose: 'p', question: 'q', ruleSaid: true, modelSaid: null });
    expect(db().prepare('SELECT COUNT(*) AS n FROM decision_shadow').get()).toEqual({ n: 1 });
  });
});

describe('t274 fix round 1: the score is held in memory and kept current as the judged rows change', () => {
  it('a truth written after the score was read joins it; a judged row rotated out leaves it — no re-read of the log', () => {
    const now = Date.now();
    expect(scoreQuestion('p', 'q')).toBeNull();   // read once: nothing judged
    recordShadow({ purpose: 'p', question: 'q', turnId: 'live', ruleSaid: false, modelSaid: noul(0.9) });
    db().prepare(`INSERT INTO decision_shadow (purpose, question, turn_id, rule_said, model_said, created_at)
      VALUES ('p', 'q', 'old', 'true', '{"type":"noul","noul":0.2}', ?)`).run(now - 3 * SHADOW_REPORT_WINDOW_MS);
    recordTruth('live', 'q', true, 'test');
    recordTruth('old', 'q', true, 'test');
    const prepare = db().prepare.bind(db());
    let shadowScans = 0;
    (db() as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      if (/^\s*SELECT[\s\S]*FROM decision_shadow WHERE 1 = 1/i.test(sql)) shadowScans++;
      return prepare(sql);
    };
    expect(scoreQuestion('p', 'q')).toMatchObject({ n: 2, ruleAcc: 0.5, modelAcc: 0.5 });
    rotateDecisionShadow(now);
    expect(scoreQuestion('p', 'q')).toMatchObject({ n: 1, ruleAcc: 0, modelAcc: 1 });
    expect(shadowScans).toBe(0);
  });
});
