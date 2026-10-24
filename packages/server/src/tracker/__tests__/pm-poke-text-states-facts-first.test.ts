// v3.5 text wave — the PM's check-ins state the facts first and put "still on it" before any close
// (done-is-measured Part C5). A measured task with items left carries its count. The PM's rejection
// and the tracker's creation / delivered-work lines lose their closure coaching.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-poke-text', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: vi.fn(async () => undefined) }), stopAgent: vi.fn() }));

import { runMigrations } from '../../db/migrations.js';
import { buildPokeMessage } from '../pm-agent.js';
import { getTask } from '../schema.js';
import { seedTrackerTask } from '../../work/__tests__/work-fixture.js';
import { engineText } from '../../agent/v2/__tests__/engine-sources.js';

const db = (): Database.Database => mockDb.current!;
const TASK = 'task-poke-text';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('prov-a', 'Cloud Provider', 'openai-compatible', 'api_key')`).run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id) VALUES ('m-a', 'prov-a', 'Model A', 'model-a')`).run();
  db().prepare(`INSERT INTO agents (id, name, status, model_id, classification) VALUES ('helper', 'Helper', 'idle', 'm-a', 'apprentice')`).run();
  seedTrackerTask(db(), { id: TASK, agentId: 'helper', status: 'in_progress', title: 'the mailbox sweep', opened_at: Date.now(), updated_at: Date.now(), priority: 'normal' } as never);
});

const poke = (type: string): string => buildPokeMessage(getTask(TASK)!, type, 1, 600, 1);
const TIERS = ['nudge', 'urgent', 'escalate_assignee', 'redrive'];

describe('the PM check-in tiers', () => {
  it.each(TIERS)('%s: work_note comes before any status, and "finished" (if offered) comes last', (type) => {
    const text = poke(type);
    const note = text.indexOf('work_note');
    expect(note).toBeGreaterThan(-1);
    for (const w of ['status="paused"', 'status="blocked"', 'status="complete"', 'If it is finished', 'Finished?']) {
      const at = text.indexOf(w);
      if (at > -1) expect(at).toBeGreaterThan(note);
    }
    expect(text).not.toMatch(/If you've finished/);
  });

  it('a measured task with items left carries its count on every tier', () => {
    db().prepare('UPDATE work SET measure_json = ?, measure_initial = 50, measure_remaining = 12, measure_at = 1 WHERE id = ?')
      .run(JSON.stringify({ tool: 'gmail_search', args: { query: 'in:inbox -label:Done' }, unit: 'messages' }), TASK);
    for (const type of [...TIERS, 'escalate_primary']) {
      expect(poke(type)).toContain('Its measure (gmail_search "in:inbox -label:Done") still returns 12 messages (of 50 at the start).');
    }
  });

  it('an unmeasured task carries no measure line', () => {
    expect(poke('nudge')).not.toContain('Its measure');
  });
});

describe('the tracker lines around a close', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools.ts'), 'utf8');
  it('the rejection drops "validates fast", the delivered-work line drops "NOW", creation drops the step-close instruction', () => {
    expect(src).not.toContain('PM validates fast');
    expect(src).not.toContain('close it NOW');
    expect(src).not.toContain('to mark steps complete');
    expect(src).not.toContain('as you finish each');
  });

  it('t250 parked: the escalation about a measured task with items left does not invite a close', () => {
    db().prepare('UPDATE work SET measure_json = ?, measure_initial = 50, measure_remaining = 12, measure_at = 1 WHERE id = ?')
      .run(JSON.stringify({ tool: 'gmail_search', args: { query: 'in:inbox -label:Done' }, unit: 'messages' }), TASK);
    const text = buildPokeMessage(getTask(TASK)!, 'escalate_primary', 1, 600, 1);
    expect(text).toContain('For your awareness. Its measure (gmail_search "in:inbox -label:Done") still returns 12 messages (of 50 at the start). It is done when that reads 0. Do not close it for the agent.');
    expect(text).not.toContain('status="complete"');
  });

  it('t250 parked: the measure-set line does not offer the remainder exit before any item is touched', () => {
    const gate = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'measure-gate.ts'), 'utf8');
    expect(gate).toContain('now. It is done when that reads 0.`');
    expect(gate).not.toContain('or when you name what is left.`');
  });

  it('orchestrator ruling: the PM report and the delivery steer carry no bias toward closing or validating', () => {
    const pm = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'pm-agent.ts'), 'utf8');
    for (const s of ['Bias toward validate', 'CLOSE-OUT NEEDED', 'with the result NOW', 'whatever it takes to make sure the task actually']) expect(pm).not.toContain(s);
    expect(pm).toContain('Judge it now on its record (the measure, ');
  });
  it('orchestrator ruling: the validation record names the measure and what was touched (E1 renders it as Measure/Ledger lines)', async () => {
    const { validationMeasureLines } = await import('../job-loop-facts.js');
    expect(validationMeasureLines(TASK)).toBe('\n  Measure: none set\n  Ledger: 0 items touched (none)');
    db().prepare('UPDATE work SET measure_json = ?, measure_initial = 50, measure_remaining = 12, measure_at = 0 WHERE id = ?')
      .run(JSON.stringify({ tool: 'gmail_search', args: { query: 'in:inbox -label:Done' }, unit: 'messages' }), TASK);
    expect(validationMeasureLines(TASK)).toBe('\n  Measure: gmail_search "in:inbox -label:Done": 12 remaining of 50 at start\n  Ledger: 0 items touched (none)');
  });

  it('fix round 2: no closure push in the thrash breaker, the closeout-miss notice or the takeover refusal', () => {
    const read = (rel: string): string => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', rel), 'utf8');
    const thrash = engineText();   // the step packages through the one shared corpus (the thrash gate is one)
    expect(thrash).not.toMatch(/without wrapping up|never wrapping up|mark complete, or block/);
    expect(thrash).toContain('repeated refused calls');
    const pm = read('tracker/pm-agent.ts');
    expect(pm).not.toMatch(/Non-idempotent tools demand|stays in_progress and continues/);
    expect(pm).toContain('That one call is not the whole job: judge the task on its record');
    expect(read('work/row-authority.ts')).not.toContain('close it out with status="complete"');
  });
});
