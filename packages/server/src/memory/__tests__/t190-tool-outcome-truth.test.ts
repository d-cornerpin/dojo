// ════════════════════════════════════════════════════════════════════════════════════════
// t190 C1 — "UNRESOLVED FAILURE ... with no success since" MUST BE TRUE, OR NOT PRINTED.
//
// THE INCIDENT (GitHub #16). A mailbox worker blocked itself four times because its status
// block said the Gmail label tool was broken. It was not. One call to the tool had failed on
// one email, weeks earlier; the tool then worked on every other email. The status line read
// `agent_tool_failures`, a per-CALL circling record cleared only when the IDENTICAL call
// (same canonical signature) succeeds, so a success on any other email never cleared it, and
// the block printed a sentence nobody had checked: "with no success since".
//
// WHAT IS PINNED. The line reads a per-(agent, tool) OUTCOME record written on every tool
// result. A tool's later success supersedes its earlier failure whatever the arguments; a
// failure is shown only while it is the last thing that happened to that tool, always with
// its recorded instant; "no success ... since" appears only for a failure the record shows
// to be unanswered. `agent_tool_failures` keeps its one job (the circling note).
//
// RED-FIRST: the first clause fails on the v3.3.3 base by printing the false line.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* not exercised */ } }));

// The three doors the lane asks, stubbed at the module boundary exactly as
// the-status-line-beats-the-note.test.ts does; the OUTCOME ledger is real rows.
const world = {
  statuses: [
    { name: 'google' as const, configured: true, connected: true },
    { name: 'microsoft' as const, configured: true, connected: true },
    { name: 'plaud' as const, configured: true, connected: true },
  ],
};
vi.mock('../../services/capability-registry.js', () => ({ listIntegrationStatuses: () => world.statuses }));
vi.mock('../../agent/access/read.js', () => ({
  mayUsePlaud: () => true,
  widestIntegrationLevel: () => 'full',
}));
vi.mock('../../plaud/auth.js', () => ({
  getPlaudStatus: () => ({
    connected: true, reauthRequired: false, email: 'owner@example.com',
    connectedAt: '2026-09-14T06:22:14.954Z', loginInProgress: false, loginUrl: null,
  }),
}));

import { runMigrations } from '../../db/migrations.js';
import { recordToolOutcome } from '../../agent/v2/attempt-record.js';
import { buildIntegrationStatusLane, forgetToolFamilyIndex } from '../integration-status-lane.js';

const AGENT = 'agent-t190';
const HERE = path.dirname(fileURLToPath(import.meta.url));

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mockDb.current.prepare(
    "INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'T190', 'idle', NULL, '{}')",
  ).run(AGENT);
  forgetToolFamilyIndex();
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

const googleLine = (block: string | null): string =>
  (block ?? '').split('\n').find((l) => l.startsWith('• Google Workspace')) ?? '';

describe('t190 C1 — a tool\'s later success ends its earlier failure', () => {
  it('THE INCIDENT: one old failure on one signature, later successes on OTHER signatures -> no UNRESOLVED FAILURE', async () => {
    recordToolOutcome(AGENT, 'gmail_label', 'gmail_label|msg-A', true);
    recordToolOutcome(AGENT, 'gmail_label', 'gmail_label|msg-B', false);
    recordToolOutcome(AGENT, 'gmail_label', 'gmail_label|msg-C', false);
    const line = googleLine(await buildIntegrationStatusLane(AGENT));
    expect(line).toContain('Google Workspace');
    expect(line).not.toContain('UNRESOLVED FAILURE');
    expect(line).not.toContain('no success');
    expect(line).toContain('No unresolved tool failure on record.');
  });

  it('a failure AFTER a success IS printed, with its recorded instant and its streak', async () => {
    recordToolOutcome(AGENT, 'gmail_label', 'gmail_label|msg-A', false);
    recordToolOutcome(AGENT, 'gmail_label', 'gmail_label|msg-B', true);
    recordToolOutcome(AGENT, 'gmail_label', 'gmail_label|msg-C', true);
    const line = googleLine(await buildIntegrationStatusLane(AGENT));
    expect(line).toMatch(/UNRESOLVED FAILURE: gmail_label, last failed \[[^\]]+\], 2 in a row, with no success of that tool since\./);
  });

  it('a history of pure failure is still printed', async () => {
    recordToolOutcome(AGENT, 'gmail_search', 'gmail_search|q1', true);
    const line = googleLine(await buildIntegrationStatusLane(AGENT));
    expect(line).toMatch(/UNRESOLVED FAILURE: gmail_search, last failed \[[^\]]+\], 1 in a row, with no success of that tool since\./);
  });

  it('the record is per TOOL: another tool\'s success in the same family does not end this tool\'s failure', async () => {
    recordToolOutcome(AGENT, 'gmail_label', 'gmail_label|msg-A', true);
    recordToolOutcome(AGENT, 'gmail_search', 'gmail_search|q1', false);
    const line = googleLine(await buildIntegrationStatusLane(AGENT));
    expect(line).toMatch(/UNRESOLVED FAILURE: gmail_label,/);
  });

  it('Plaud, which has no success ledger, gets the same truth from the outcome record', async () => {
    recordToolOutcome(AGENT, 'plaud_recent_recordings', 'p|1', true);
    recordToolOutcome(AGENT, 'plaud_recent_recordings', 'p|2', false);
    const plaud = (await buildIntegrationStatusLane(AGENT) ?? '').split('\n').find((l) => l.startsWith('• Plaud')) ?? '';
    expect(plaud).not.toContain('UNRESOLVED FAILURE');
  });
});

describe('t190 C1 — the record itself, and the old mechanism', () => {
  it('every result writes the per-tool record: last success, last failure with its error text, streak', () => {
    recordToolOutcome(AGENT, 'gmail_label', 'sig-1', true, 'Error modifying labels: Invalid label: Junk');
    recordToolOutcome(AGENT, 'gmail_label', 'sig-2', true, 'Error modifying labels: again');
    let row = mockDb.current!.prepare('SELECT * FROM agent_tool_outcomes WHERE agent_id = ? AND tool_name = ?')
      .get(AGENT, 'gmail_label') as Record<string, unknown>;
    expect(row.consecutive_failures).toBe(2);
    expect(row.total_failures).toBe(2);
    expect(row.last_error).toBe('Error modifying labels: again');
    expect(row.last_ok_at).toBeNull();
    recordToolOutcome(AGENT, 'gmail_label', 'sig-3', false);
    row = mockDb.current!.prepare('SELECT * FROM agent_tool_outcomes WHERE agent_id = ? AND tool_name = ?')
      .get(AGENT, 'gmail_label') as Record<string, unknown>;
    expect(row.consecutive_failures).toBe(0);
    expect(row.total_failures).toBe(2);
    expect(row.last_ok_at).toBeTruthy();
    expect(row.last_fail_at).toBeTruthy();
  });

  it('agent_tool_failures stays the CIRCLING record: per signature, cleared by the identical call only', () => {
    expect(recordToolOutcome(AGENT, 'gmail_label', 'sig-1', true)).toBe(1);
    expect(recordToolOutcome(AGENT, 'gmail_label', 'sig-1', true)).toBe(2);
    recordToolOutcome(AGENT, 'gmail_label', 'sig-other', false);
    const n = () => (mockDb.current!.prepare('SELECT COUNT(*) AS n FROM agent_tool_failures WHERE agent_id = ?').get(AGENT) as { n: number }).n;
    expect(n()).toBe(1);
    recordToolOutcome(AGENT, 'gmail_label', 'sig-1', false);
    expect(n()).toBe(0);
  });

  it('OLD MECHANISM GONE: the status lane no longer reads agent_tool_failures', () => {
    const src = fs.readFileSync(path.join(HERE, '..', 'integration-status-lane.ts'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(code).not.toContain('agent_tool_failures');
    expect(code).toContain('readToolOutcomes');
  });
});
