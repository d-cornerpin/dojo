// ════════════════════════════════════════════════════════════════════════════
// T198 / E3 — A REPORT'S SIGNATURE SAYS WHAT THE REPORT IS ABOUT, NOT WHAT THE AGENT
// HAS BEEN FAILING AT LATELY (GitHub #11 and #12 collided on one signature).
//
//   1. The dominant failure is ranked from IN-WINDOW evidence only. A failure streak that
//      was built up outside the window (the cumulative `agent_tool_failures` counter) must
//      not move the signature.
//   2. Two windows with different in-window failures hash differently.
//   3. No in-window failure never becomes the literal `unrecorded` tool token.
//   4. The platform version is not in the hash (owner decision 17): the same defect on two
//      releases is the same issue.
//   5. The scheme prefix is `ds2-`, and the telemetry whitelist admits it (and still admits
//      a `ds1-` row that was drafted before the upgrade).
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations.js';
import { gatherEvidence } from '../gather.js';
import { deriveReportSignature, dominantToken } from '../signature.js';
import { TELEMETRY_WHITELIST } from '../telemetry-whitelist.js';

const AGENT = 'agent-t198-signature';
const NOW = new Date('2026-09-24T12:00:00.000Z');
const T_IN = '2026-09-24 11:00:00';
const MS_IN = Date.parse('2026-09-24T11:00:00Z');

function base(): void {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO providers (id, name, type, auth_type) VALUES ('p-s', 'P', 'anthropic', 'none')").run();
  db.prepare("INSERT OR IGNORE INTO models (id, provider_id, name, api_model_id) VALUES ('m-s', 'p-s', 'M', 'm')").run();
  db.prepare("INSERT OR IGNORE INTO agents (id, name, model_id, status) VALUES (?, 'A', 'm-s', 'idle')").run(AGENT);
}

/** One in-window tool call that the audit log recorded with `result`. */
function call(n: number, tool: string, result: string): void {
  const callId = `call_${tool}_${n}`;
  getDb().prepare(
    `INSERT INTO audit_log (id, agent_id, action_type, target, result, detail, call_id, created_at)
     VALUES (?, ?, 'file_read', 't', ?, 'd', ?, ?)`,
  ).run(`al-${tool}-${n}`, AGENT, result, callId, T_IN);
  getDb().prepare(
    `INSERT INTO messages (id, agent_id, role, lane, content, display_kind, display_tier,
                           turn_number, provenance, authorized, token_count, created_at)
     VALUES (?, ?, 'assistant', 'owner', ?, 'agent-text', 'agent-only', 1, 'live', 1, 10, ?)`,
  ).run(`m-${tool}-${n}`, AGENT, JSON.stringify([
    { type: 'tool_use', id: callId, name: tool, input: { path: 'x' } },
  ]), MS_IN + n);
}

/** The cumulative per-agent streak counter. `lastAt` inside the window, hits mostly outside it. */
function streak(tool: string, hits: number): void {
  getDb().prepare(
    `INSERT INTO agent_tool_failures (agent_id, signature, tool_name, hit_count, last_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(AGENT, `sig-${tool}`, tool, hits, T_IN);
}

const sigOf = (): string => deriveReportSignature('other', gatherEvidence(AGENT, {}, NOW).dominant);

beforeEach(() => {
  runMigrations();
  const db = getDb();
  for (const t of ['turns', 'audit_log', 'agent_tool_failures', 'messages']) {
    db.prepare(`DELETE FROM ${t} WHERE agent_id = ?`).run(AGENT);
  }
  base();
});

describe('the dominant failure is ranked from in-window evidence only', () => {
  it('is unmoved by a failure streak built outside the window', () => {
    call(1, 'file_read', 'denied');
    const quiet = dominantToken(gatherEvidence(AGENT, {}, NOW).dominant);
    streak('work_update', 40);            // 40 cumulative failures, none of them in this window
    streak('file_read', 3);
    const noisy = dominantToken(gatherEvidence(AGENT, {}, NOW).dominant);
    expect(noisy).toBe(quiet);
    expect(noisy).toBe('tool:file_read:denied');
  });

  it('never mints the literal `unrecorded` for a streak with no in-window verdict (the #11/#12 shape)', () => {
    streak('work_update', 12);
    const token = dominantToken(gatherEvidence(AGENT, {}, NOW).dominant);
    expect(token).not.toContain('unrecorded');
    expect(token).toBe('none');
  });

  it('ranks by the in-window count, ties by tool name', () => {
    call(1, 'file_read', 'denied');
    call(2, 'web_fetch', 'error'); call(3, 'web_fetch', 'error');
    expect(dominantToken(gatherEvidence(AGENT, {}, NOW).dominant)).toBe('tool:web_fetch:error');
  });

  it('hashes two reports with different in-window failures differently', () => {
    call(1, 'file_read', 'denied');
    const a = sigOf();
    getDb().prepare('DELETE FROM audit_log WHERE agent_id = ?').run(AGENT);
    getDb().prepare('DELETE FROM messages WHERE agent_id = ?').run(AGENT);
    call(1, 'web_fetch', 'error');
    expect(sigOf()).not.toBe(a);
  });
});

describe('the signature is version-free and carries the ds2- prefix', () => {
  const d = { toolFailures: [{ tool: 'exec', result: 'error', count: 2 }], turnExits: [] };

  it('is the same defect on two platform versions, one signature', () => {
    // `deriveReportSignature(lane, dominant)` has no version argument, so nothing about the
    // release can reach the hash; the same inputs are the same token wherever they are run.
    expect(deriveReportSignature('tool-error', d)).toMatch(/^ds2-[0-9a-f]{12}$/);
    expect(deriveReportSignature('tool-error', d)).toBe(deriveReportSignature('tool-error', d));
    expect(deriveReportSignature('tool-error', d)).not.toBe(deriveReportSignature('silence', d));
  });

  it('the production source no longer reads the version into the hash', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../signature.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\$\{platformVersion\}/);
    expect(src).not.toMatch(/`ds1-\$\{/);
  });
});

describe('the telemetry whitelist admits the signature the platform mints', () => {
  const field = TELEMETRY_WHITELIST.find(f => f.path === 'report.signature');
  it('admits ds2-, and still ds1- (a draft written before the upgrade)', () => {
    expect(field?.pattern?.test('ds2-9f2c1a0b4d77')).toBe(true);
    expect(field?.pattern?.test('ds1-9f2c1a0b4d77')).toBe(true);
    expect(field?.pattern?.test('ds3-9f2c1a0b4d77')).toBe(false);
  });
});
