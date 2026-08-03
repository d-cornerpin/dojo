// ════════════════════════════════════════════════════════════════════════════
// PHASE-5 T6 — THE AUDIT ROW IS NOT A HOLE IN THE CREDENTIAL SEAM.
//
// WHY THIS FILE EXISTS, and it was measured on the box rather than imagined.
// The owner's binding requirement for T6 is that a stored credential stays
// USABLE: the agent fetches it with `credential_get` and hands the real value
// to a real command through the exec door. That flow works — a driven proof on
// the dev box ran it through three loop iterations and the spawned process
// received the real value every time.
//
// The flow also wrote the credential into `audit_log.target` THREE TIMES, once
// per exec call, in the clear. `process-run.ts` audits `auditTarget` — the argv
// line as run — and the argv line is exactly where a fetched credential has to
// be for the capability to work at all. So the capability the owner requires
// was, by construction, minting a plaintext copy at rest on every use.
//
// That is the twin obligation failing on its refusal half: proving "the agent
// can still use it" while leaving this open would have landed a leak and called
// it a feature. `audit_log` has no TTL, is exported by the diagnostics path, and
// no clause anywhere gated the column.
//
// THE KEY IS THE DECLARED VALUE SET, NEVER A SHAPE. `redactHandedCredentials`
// only knows values this process learned from a DECLARED secret field (a tool's
// own `fields: { x: { secret: true } }`) or handed out through `credential_get`.
// A secret-shaped string nobody declared is left alone on purpose — clause 4
// below pins that, because a value matcher is the prose-keying this overhaul
// exists to delete.
//
// RED-FIRST RECORD, as measured rather than as predicted: against `auditLog`
// before the fix this file ran 3 failed / 3 passed — clauses 1, 2 and 3 FAIL,
// and clauses 4, 5 and 6 pass. The two negative controls passing in the red is
// the point: they are insensitive to the fix by design, so a run where they
// also failed would mean the harness was broken rather than the seam. Clause 6
// passes in both states on purpose — it is a no-crash guard on the seam, not a
// redaction assertion, and it exists so a null-target caller cannot be broken
// by the scrub.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import { auditLog } from '../util.js';
import {
  REDACTED_CREDENTIAL,
  noteHandedCredentialValues,
  forgetHandedCredentialValues,
} from '../../../credentials/secret-values.js';

const AGENT = 'agent-under-test';
const OTHER_AGENT = 'someone-else';
/** Distinctive, and long enough to clear the value set's 6-char floor. */
const SECRET = 'sk-live-t6-9zqp4m7v2xkd';

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE audit_log (
      id TEXT PRIMARY KEY, agent_id TEXT, action_type TEXT, target TEXT,
      result TEXT, detail TEXT, turn_number INTEGER, call_id TEXT,
      root_kind TEXT, root_id TEXT, created_at TEXT
    );
  `);
  mockDb.current = db;
  forgetHandedCredentialValues();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  forgetHandedCredentialValues();
});

const rows = () =>
  mockDb.current!.prepare('SELECT agent_id, action_type, target, detail FROM audit_log').all() as
    Array<{ agent_id: string; action_type: string; target: string | null; detail: string | null }>;

describe('auditLog redacts credential values this agent has handled', () => {
  it('1. the exec argv line — the shape the driven proof produced on the box', () => {
    noteHandedCredentialValues(AGENT, [SECRET]);
    auditLog(AGENT, 'exec', `sh /tmp/capture.sh ${SECRET} one`, 'success', 'captured-one');

    const [row] = rows();
    expect(row.target).toBe(`sh /tmp/capture.sh ${REDACTED_CREDENTIAL} one`);
    expect(row.target).not.toContain(SECRET);
  });

  it('2. the detail column too — a command that echoes the key to stdout', () => {
    noteHandedCredentialValues(AGENT, [SECRET]);
    auditLog(AGENT, 'exec', 'echo the-key', 'success', `stdout: ${SECRET}`);

    const [row] = rows();
    expect(row.detail).toBe(`stdout: ${REDACTED_CREDENTIAL}`);
    expect(row.detail).not.toContain(SECRET);
  });

  it('3. every action type, not just exec — one seam, no per-caller opt-in', () => {
    noteHandedCredentialValues(AGENT, [SECRET]);
    auditLog(AGENT, 'file_write', `/tmp/${SECRET}.env`, 'success', `wrote ${SECRET}`);
    auditLog(AGENT, 'some_unmapped_tool', `arg=${SECRET}`, 'success');

    for (const row of rows()) {
      expect(row.target ?? '').not.toContain(SECRET);
      expect(row.detail ?? '').not.toContain(SECRET);
    }
  });

  it('4. NEGATIVE CONTROL — a secret-shaped string nobody declared is left alone', () => {
    // Nothing was noted for this agent, so nothing is known to be secret. A
    // value matcher would fire here; the declared-value set must not.
    auditLog(AGENT, 'exec', 'curl -H "Authorization: Bearer sk-live-not-declared-abc"', 'success');

    const [row] = rows();
    expect(row.target).toContain('sk-live-not-declared-abc');
  });

  it('5. NEGATIVE CONTROL — one agent\'s credential is not scrubbed from another\'s row', () => {
    noteHandedCredentialValues(AGENT, [SECRET]);
    auditLog(OTHER_AGENT, 'exec', `sh run.sh ${SECRET}`, 'success');

    const [row] = rows();
    expect(row.agent_id).toBe(OTHER_AGENT);
    expect(row.target).toContain(SECRET);
  });

  it('6. a null target and an absent detail still write a row (no crash on the seam)', () => {
    noteHandedCredentialValues(AGENT, [SECRET]);
    auditLog(AGENT, 'exec', null, 'denied');

    const [row] = rows();
    expect(row.target).toBeNull();
    expect(row.detail).toBeNull();
    expect(row.action_type).toBe('exec');
  });
});
