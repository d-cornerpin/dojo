// v3.5 B3 — RULE → SHADOW → MODEL, PER QUESTION, DECIDED BY MEASURED ACCURACY. Owner, 2026-10-19: "the
// Dojo switches a question itself once the model proves better." A question goes to the model only when
// the model's whole 95 % range sits above the rule's, and back to shadow when the ranges overlap again.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-decision-policy', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { modeFor, getDecisionScoreItems, SWITCH_SENTENCE } from '../decision-policy.js';
import { recordShadow, recordTruth, __resetShadowRotationForTests } from '../decision-shadow.js';
import { compileDiagnosticReport } from '../../healer/diagnostic.js';
import { STANDARD_DECISION_MODEL } from '../../services/local-standard.js';

const db = (): Database.Database => mockDb.current!;
let turn = 0;
/** `n` judged turns on purpose/question: the rule right `ruleRight` times, the model `modelRight` times. */
function seed(purpose: string, question: string, n: number, ruleRight: number, modelRight: number): void {
  for (let i = 0; i < n; i++) {
    const t = `turn-${turn++}`;
    recordShadow({ purpose, question, turnId: t, ruleSaid: i < ruleRight, modelSaid: { type: 'noul', noul: i < modelRight ? 0.9 : 0.1 } });
    recordTruth(t, question, true, 'ledger');
  }
}
function installDecisionModel(): void {
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', 'http://localhost:11434', 'none', 1)").run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled) VALUES ('m-decision', 'ollama-local', ?, ?, '["decision"]', 1)`)
    .run(STANDARD_DECISION_MODEL.tag, STANDARD_DECISION_MODEL.tag);
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  __resetShadowRotationForTests();
  installDecisionModel();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('modeFor', () => {
  it('rule: no decision model installed, whatever the score says', () => {
    seed('p', 'q', 60, 20, 60);
    db().prepare("DELETE FROM models WHERE id = 'm-decision'").run();
    expect(modeFor('p', 'q')).toBe('rule');
  });

  it('shadow: no evidence yet', () => { expect(modeFor('p', 'q')).toBe('shadow'); });

  it('shadow: the model scores higher but the ranges overlap (8/10 vs 6/10)', () => {
    seed('p', 'q', 10, 6, 8);
    expect(modeFor('p', 'q')).toBe('shadow');
  });

  it('model: the model\'s whole range sits above the rule\'s (58/60 vs 30/60)', () => {
    seed('p', 'q', 60, 30, 58);
    expect(modeFor('p', 'q')).toBe('model');
  });

  it('a pinned row wins: the owner pinned this question to the rule', () => {
    seed('p', 'q', 60, 30, 58);
    db().prepare("INSERT INTO config (key, value) VALUES ('decision_mode.p.q', 'rule')").run();
    expect(modeFor('p', 'q')).toBe('rule');
  });

  it('RULING (fix round 1): the owner cannot pin a question to the model, or to shadow — the Dojo flips it itself', () => {
    seed('p', 'q', 10, 6, 8);
    db().prepare("INSERT INTO config (key, value) VALUES ('decision_mode.p.q', 'model')").run();
    expect(modeFor('p', 'q')).toBe('shadow');
    seed('p', 'q2', 60, 30, 58);
    db().prepare("INSERT INTO config (key, value) VALUES ('decision_mode.p.q2', 'shadow')").run();
    expect(modeFor('p', 'q2')).toBe('model');
  });

  it('demotion: a question in model mode returns to shadow when the ranges overlap again', () => {
    seed('p', 'q', 60, 30, 58);
    expect(modeFor('p', 'q')).toBe('model');
    seed('p', 'q', 60, 60, 20);   // the model starts getting it wrong
    expect(modeFor('p', 'q')).toBe('shadow');
  });
});

describe('the Healer report carries the score', () => {
  it('every question with n, both accuracies, the intervals and the mode, and the switching sentence', () => {
    seed('reply_claims', 'claims_saved', 60, 30, 58);
    seed('reply_claims', 'claims_sent', 10, 6, 8);
    const items = getDecisionScoreItems();
    expect(items).toHaveLength(1);
    const detail = items[0].detail;
    expect(detail).toContain('reply_claims / claims_saved: n=60, rule 50% [38–62], model 97% [89–99], mode model');
    expect(detail).toContain('reply_claims / claims_sent: n=10, rule 60% [31–83], model 80% [49–94], mode shadow');
    expect(detail).toContain(SWITCH_SENTENCE);
    expect(SWITCH_SENTENCE).toBe("A question switches to the model when the model's range sits above the rule's, and back when it does not.");
    expect(compileDiagnosticReport().reportText).toContain('reply_claims / claims_saved: n=60');
  });

  it('a box that has asked nothing has no section', () => {
    expect(getDecisionScoreItems()).toEqual([]);
  });
});
