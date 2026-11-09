// v3.5 field fix 3, review H3: THE COMMAND LEDGER NEVER HOLDS A HANDED CREDENTIAL.
//
// The model sees the real value of a credential it was handed (hydrated at the provider boundary), so
// a `shell({script: "curl -H 'Authorization: Bearer <value>' ..."})` carries the literal value. Every
// other persistence path runs that text through the tree's one redactor (`redactHandedCredentials`,
// the process audit row at `agent/tools/util.ts:88`). The ledger did not: the value landed in
// `work_ledger.item_key`, in the PM's validation request, and in the verdict's `evidence_ref`.
// FIXTURE DISCIPLINE: the credential below is fictional, invented in this file.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-ledger-secret', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { seedTrackerTask } from './work-fixture.js';
import { recordCallsTouched } from '../ledger-store.js';
import { validationMeasureLines } from '../../tracker/job-loop-facts.js';
import { noteHandedCredentialValues } from '../../credentials/secret-values.js';
import { endTurnContext } from '../../agent/turn-context.js';

const WORKER = 'ledger-worker';
const PM = 'ledger-pm';
const TASK = 'task-ledger-secret';
const SECRET = 'fictional-tok-9Zq77LmQ0aXv';
const SHELL = [{ kind: 'shell' as const, from: 'args.script' }];
const WRITE = [{ kind: 'fs_write' as const, from: 'args.path' }];
const effectsOf = (name: string) => (name === 'shell' ? SHELL : name === 'file_write' ? WRITE : undefined);
const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  for (const id of [WORKER, PM]) db().prepare("INSERT INTO agents (id, name, classification) VALUES (?, ?, 'apprentice')").run(id, id);
  seedTrackerTask(db(), { id: TASK, agentId: WORKER, status: 'in_progress', title: 'fetch the report', opened_at: Date.now(), updated_at: Date.now(), priority: 'normal' } as never);
  noteHandedCredentialValues(WORKER, [SECRET]);
});
afterEach(() => { endTurnContext(PM); mockDb.current?.close(); mockDb.current = null; });

function runTheCall(): void {
  recordCallsTouched(TASK, [
    { id: 'c1', name: 'shell', arguments: { script: `curl -H 'Authorization: Bearer ${SECRET}' https://api.example.com/r > /tmp/out/r.json` } },
    { id: 'c2', name: 'file_write', arguments: { path: `/tmp/out/${SECRET}.txt`, content: 'x' } },
  ], [
    { toolCallId: 'c1', isError: false, content: `command_failed: exit 22 (token ${SECRET} rejected)` },
    { toolCallId: 'c2', isError: false, content: 'written' },
  ], effectsOf, WORKER);
}

describe('H3: a command carrying a handed credential is stored, shown and recorded only redacted', () => {
  it('STORED: neither the ledger key nor its detail holds the value', () => {
    runTheCall();
    const rows = db().prepare('SELECT item_key, detail FROM work_ledger WHERE work_id = ?').all(TASK) as Array<{ item_key: string; detail: string | null }>;
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    expect(rows.some((r) => r.item_key.startsWith('cmd:curl') && r.item_key.includes('<redacted-credential'))).toBe(true);
  });

  it('SHOWN: the validation request prints only the redacted form', () => {
    runTheCall();
    const text = validationMeasureLines(TASK);
    expect(text).toContain('command run: curl');
    expect(text).not.toContain(SECRET);
  });
});
