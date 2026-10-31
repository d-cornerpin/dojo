// v3.5 item 29 — a question's switch to the model (and back) is recorded and told, per question, from the score.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-decision-switch', 'dojo.db'),
  };
});
const broadcast = vi.fn();
vi.mock('../../gateway/ws.js', () => ({ broadcast: (e: unknown) => broadcast(e), stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { recordShadow, recordTruth, rotateDecisionShadow, __resetShadowRotationForTests } from '../decision-shadow.js';
import { modeFor } from '../decision-policy.js';
import { switchRecord, switchedQuestions } from '../decision-switch.js';
import { STANDARD_DECISION_MODEL } from '../../services/local-standard.js';

const db = (): Database.Database => mockDb.current!;
let turn = 0;
function judged(purpose: string, question: string, n: number, ruleRight: number, modelRight: number, at = Date.now()): void {
  for (let i = 0; i < n; i++) {
    const t = `turn-${turn++}`;
    recordShadow({ purpose, question, turnId: t, ruleSaid: i < ruleRight, modelSaid: { type: 'noul', noul: i < modelRight ? 0.9 : 0.1 } });
    if (at !== Date.now()) db().prepare('UPDATE decision_shadow SET created_at = ? WHERE turn_id = ?').run(at, t);
    recordTruth(t, question, true, 'ledger');
  }
}
const cards = (): Array<{ error: string; severity: string; cardKey?: string }> => broadcast.mock.calls.map((c) => c[0]);

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  __resetShadowRotationForTests();
  broadcast.mockClear();
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', 'http://localhost:11434', 'none', 1)").run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled) VALUES ('m-decision', 'ollama-local', ?, ?, '["decision"]', 1)`)
    .run(STANDARD_DECISION_MODEL.tag, STANDARD_DECISION_MODEL.tag);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('a question switches to the model by itself, and it is recorded and told', () => {
  it('a model that proves better: recorded, one owner card for that question, others untouched', () => {
    judged('p', 'better', 60, 20, 60);
    judged('p', 'same', 60, 40, 41);
    expect(modeFor('p', 'better')).toBe('model');
    expect(modeFor('p', 'same')).toBe('shadow');
    expect(switchRecord('p', 'better')?.state).toBe('model');
    expect(switchRecord('p', 'same')).toBeNull();
    expect(switchedQuestions().map((q) => q.question)).toEqual(['better']);
    const told = cards().filter((c) => c.severity === 'warning');
    expect(told).toHaveLength(1);
    expect(told[0].cardKey).toBe('decision-switch:p:better');
    expect(told[0].error).toMatch(/better/);
  });

  it('the switch is told once, not on every further truth', () => {
    judged('p', 'q', 60, 20, 60);
    judged('p', 'q', 5, 0, 5);
    expect(cards().filter((c) => c.severity === 'warning')).toHaveLength(1);
  });

  it('a model that gets worse goes back to shadow by itself, recorded, and its card ends', () => {
    judged('p', 'q', 60, 20, 60);
    expect(modeFor('p', 'q')).toBe('model');
    broadcast.mockClear();
    judged('p', 'q', 200, 200, 0);   // the model is wrong on every new case
    expect(modeFor('p', 'q')).toBe('shadow');
    expect(switchRecord('p', 'q')).toBeNull();
    expect(cards().map((c) => c.severity)).toEqual(['info']);   // the existing END frame: the card leaves
  });

  it('old evidence ageing out can send a question back, and says so', () => {
    const old = Date.now() - 20 * 24 * 60 * 60 * 1000;
    judged('p', 'q', 60, 20, 60, Date.now());
    judged('p', 'q', 200, 200, 0, old);   // wrong cases that count until rotated... they are old: dropped by rotation
    // the score currently includes the old rows (rotation has not run); a model that looks worse is in shadow
    expect(modeFor('p', 'q')).toBe('shadow');
    rotateDecisionShadow();
    expect(modeFor('p', 'q')).toBe('model');
    expect(switchRecord('p', 'q')?.state).toBe('model');
  });

  it('no card when the owner pinned the question to the rule, but the flip is recorded', () => {
    db().prepare("INSERT INTO config (key, value) VALUES ('decision_mode.p.q', 'rule')").run();
    judged('p', 'q', 60, 20, 60);
    expect(modeFor('p', 'q')).toBe('rule');
    expect(cards()).toHaveLength(0);
  });

  it('no evidence, no switch', () => {
    judged('p', 'q', 3, 3, 0);
    expect(switchRecord('p', 'q')).toBeNull();
    expect(cards()).toHaveLength(0);
  });
});
