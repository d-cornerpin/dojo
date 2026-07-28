// ════════════════════════════════════════
// Origin-spine conformance (lanes & lineage P1, 2026-07-21)
//
// The door-lock for the lineage spine: every creation path of work records
// states its origin, and every engine-event writer states its work referent.
// The primary lock is the TYPE SYSTEM (origin/work are REQUIRED params, so an
// omitting writer fails to compile); this test guards the parts types cannot:
// the migration columns, the INSERTs actually writing them, and the two
// writers that must pass REAL referents (a scheduler fire and an assignment
// notice with work:null would silently disarm the P2 serve boundary).
//
// Source-scan style, same as two-key-conformance.test.ts.
// ════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

describe('origin-spine conformance (P1)', () => {
  it('migration 112 declares the spine columns', () => {
    const mig = read('db/migrations/112_origin_spine.sql');
    for (const col of ['source_message_id', 'origin_turn', 'origin_conv_key', 'origin_kind']) {
      expect(mig).toContain(`ALTER TABLE tasks ADD COLUMN ${col}`);
      expect(mig).toContain(`ALTER TABLE projects ADD COLUMN ${col}`);
    }
    for (const col of ['task_id', 'run_id', 'root_kind', 'root_id']) {
      expect(mig).toContain(`ALTER TABLE inter_agent_messages ADD COLUMN ${col}`);
      expect(mig).toContain(`ALTER TABLE messages ADD COLUMN ${col}`);
    }
  });

  it('createTask / createProject write the origin quad and require the origin param', () => {
    const schema = read('tracker/schema.ts');
    // Required param on both signatures (the compile-time lock's presence).
    const createTaskSig = schema.slice(schema.indexOf('export function createTask'), schema.indexOf('export function createTask') + 1200);
    const createProjectSig = schema.slice(schema.indexOf('export function createProject'), schema.indexOf('export function createProject') + 1200);
    expect(createTaskSig).toMatch(/origin:\s*\{\s*kind:/);
    expect(createProjectSig).toMatch(/origin:\s*\{\s*kind:/);
    // Every INSERT INTO tasks in schema.ts carries origin columns (the a2a
    // auto-task INSERT stamps a literal origin_kind instead of the quad).
    const taskInserts = schema.split('INSERT INTO tasks').slice(1);
    expect(taskInserts.length).toBeGreaterThanOrEqual(3);
    for (const ins of taskInserts) {
      const head = ins.slice(0, 400);
      expect(head, 'a task INSERT is missing origin columns').toMatch(/source_message_id/);
      expect(head).toMatch(/origin_kind|'a2a_assign'/);
    }
    expect(schema.split('INSERT INTO projects').slice(1)[0]).toMatch(/source_message_id, origin_turn, origin_conv_key, origin_kind/);
  });

  it('the scheduler fire and the assignment notice pass REAL work referents', () => {
    const runner = read('scheduler/runner.ts');
    expect(runner).toMatch(/work:\s*\{\s*taskId,\s*runId,\s*rootKind:\s*'occurrence',\s*rootId:\s*runId\s*\}/);
    const notify = read('tracker/notify.ts');
    expect(notify).toMatch(/work:\s*\{\s*taskId,\s*runId:\s*null,\s*rootKind:\s*'task',\s*rootId:\s*taskId\s*\}/);
  });

  it('the engine-row writer persists the work referent columns', () => {
    // PHASE-1 T4 (2026-07-27): interagent.ts became a shim over memory/message-store.ts, so
    // the engine row's columns are named as writer-module FIELDS rather than in a raw column
    // list. PHASE-1 T10 (2026-07-28): the shim is DELETED, and the requirement moved with it
    // rather than dying with it — `work` is now a REQUIRED field on the writer module's own
    // `insertEngineEvent` / `insertEngineEventIfAbsent`, where `null` is a legal and
    // deliberate answer. That is what this assertion follows.
    //
    // The requirement is untouched at both ends: an engine row must carry the work referent
    // the serve boundary re-checks its premise against, so the parameter must be REQUIRED
    // (not optional — optional is how a new writer forgets in silence) and the single writer
    // must persist all four columns. Asserting the old shim's `params.work?.` literal would
    // have gone quietly vacuous the moment that file was deleted.
    const store = read('memory/message-store.ts');
    expect(store, 'engine rows must declare their work referent, and `null` must be explicit')
      .toMatch(/work:\s*EngineEventWork\s*\|\s*null/);
    expect(store, '`work` must not be optional — an optional referent is a forgotten one')
      .not.toMatch(/work\?\s*:\s*EngineEventWork/);
    const engineRow = store.slice(store.indexOf('function engineRow('), store.indexOf('function engineRow(') + 700);
    for (const field of ['taskId', 'runId', 'rootKind', 'rootId']) {
      expect(engineRow, `the engine-row writer must pass ${field}`).toContain(`work?.${field}`);
    }
    expect(store, 'the single writer must persist the work referent columns')
      .toMatch(/task_id, run_id, root_kind, root_id/);
  });

  it('the a2a auto-task stores its assign message id', () => {
    const schema = read('tracker/schema.ts');
    const fn = schema.slice(schema.indexOf('export function autoCreateAssignTask'));
    expect(fn.slice(0, 8000)).toMatch(/assignMessageId/);
    expect(fn.slice(0, 8000)).toMatch(/'a2a_assign'/);
  });
});
