// ════════════════════════════════════════════════════════════════════════════════════════
// t192 D5 — AN ASSEMBLY SHAPE FAULT IS AN ENGINE DEFECT, NEVER "YOU CALLED A TOOL THAT DOES NOT EXIST".
//
// The witness (conversation 8): the validator's own text for a shape fault ("…sanitizeOrphanToolBlocks
// … an unknown defect …") holds "tool" and "unknown", and `classifyRecoverableProviderError` read that
// as a provider "tool_name_unknown" 400. The agent was told its last tool call named a tool that does
// not exist (it had made no such call), the same note repeated until the same-inputs cap, and only then
// did the Healer hear of it. The error has a TYPE (`AssemblyValidationError`); recovery now branches on
// it before any text rule.
//
// The error is built by the REAL repair (`repairAssembly`) from a real shape-faulty array, so the text
// is the validator's own, not a paraphrase. Driven through the real recovery door (`recoverFromError`)
// and the real Healer injury door. RED-FIRST on e63aa3d7: the first three clauses fail there.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-t192-shape');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t192-shape');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
    isTestRun: (): boolean => true,
  };
});

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t192-shape', 'dojo.db'),
  };
});

const { broadcasts } = vi.hoisted(() => ({ broadcasts: [] as Array<Record<string, unknown>> }));
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (e: Record<string, unknown>) => { broadcasts.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({
    notifyPrimaryOfInjury: vi.fn(async () => undefined),
    handleMessage: vi.fn(async () => undefined),
  }),
}));
vi.mock('../../agent/a2a-transport.js', () => ({ deliverA2AMessage: vi.fn(async () => ({ delivered: true })) }));
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  const record = (): string => '';
  return { ...orig, default: { ...orig, execSync: record, execFileSync: record }, execSync: record, execFileSync: record };
});

import { runMigrations } from '../../db/migrations.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
import { recoverFromError } from '../v2/recovery.js';
import { initState } from '../v2/state.js';
import { AgentError, clearErrors } from '../errors.js';
import { classifyProviderError } from '../provider-error.js';
import { repairAssembly, AssemblyValidationError } from '../../memory/assembly-validation.js';

const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, '.dojo', 'logs'), { recursive: true });
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  broadcasts.length = 0;
  d.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('prov-a', 'Cloud Provider', 'openai-compatible', 'api_key')`).run();
  d.prepare(`INSERT INTO models (id, provider_id, name, api_model_id) VALUES ('m-a', 'prov-a', 'Model A', 'model-a')`).run();
  d.prepare("INSERT INTO agents (id, name, status, model_id) VALUES ('helper', 'Helper', 'working', 'm-a'), ('hl', 'Healer', 'idle', 'm-a')").run();
  d.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('healer_agent_id', 'hl')").run();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  clearErrors('helper');
  mockDb.current?.close();
  mockDb.current = null;
});

/** The validator's own error for a real shape fault: an array whose last message is the assistant's. */
function realShapeFault(): AssemblyValidationError {
  try {
    repairAssembly(
      [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ],
      { budgetTokens: 100_000, laneIds: [null, null], agentId: 'helper' },
    );
  } catch (e) {
    if (e instanceof AssemblyValidationError) return e;
    throw e;
  }
  throw new Error('the validator did not refuse a shape-faulty array; the witness is gone');
}

async function recover(error: unknown, turnNumber = 1): Promise<void> {
  db().prepare("UPDATE agents SET status = 'working' WHERE id = 'helper'").run();
  const state = initState({
    agentId: 'helper', contextWindow: 128_000, isAutoRouted: false, configuredModelId: 'm-a',
    turnNumber, triggeredByIMessage: false, triggeredByA2AReplyIntent: null,
    lastUserMessageContent: 'please look at the file', lastUserMessageId: null, inboundChannel: null, inboundContext: null,
    pendingTechniqueAck: null,
  });
  await recoverFromError(state, error, { isUserFacingTurn: true });
}

const systemNotes = (): string[] => (db().prepare(
  "SELECT content FROM messages WHERE agent_id = 'helper' AND role = 'system' ORDER BY rowid",
).all() as Array<{ content: string }>).map((r) => r.content);
const agent = (): { status: string; last_error: string | null } =>
  db().prepare("SELECT status, last_error FROM agents WHERE id = 'helper'").get() as { status: string; last_error: string | null };

const NOT_A_TOOL_NOTE = /tool call referenced|isn't a registered tool|tool that doesn't exist/;

describe('t192 D5: a shape fault is the engine\'s defect, not a bad tool call', () => {
  it('the witness text is a real shape fault (precondition)', () => {
    const e = realShapeFault();
    expect(e.message).toContain('SHAPE violation');
    expect(e.message.toLowerCase()).toContain('tool');
    expect(e.message.toLowerCase()).toContain('unknown');
  });

  it('the agent is never told it called a tool that does not exist; the injury path runs instead', async () => {
    await recover(realShapeFault());
    expect(systemNotes().filter((n) => NOT_A_TOOL_NOTE.test(n))).toEqual([]);
    // The Healer path: the agent is locked to error with the defect's own words as the record.
    expect(agent().status).toBe('error');
    expect(agent().last_error).toContain('SHAPE violation');
  });

  it('the same fault wrapped as the auto-router wraps errors (cause chain) is still the type, not the text', async () => {
    const inner = realShapeFault();
    await recover(new Error(`No model this agent could fall back to can hold this agent's tools: ${inner.message}`, { cause: inner }));
    expect(systemNotes().filter((n) => NOT_A_TOOL_NOTE.test(n))).toEqual([]);
    expect(agent().status).toBe('error');
  });

  it('repeating on the same inputs never writes a "we tried N times" strike note either', async () => {
    for (let i = 1; i <= 4; i++) await recover(realShapeFault(), i);
    expect(systemNotes().filter((n) => NOT_A_TOOL_NOTE.test(n) || /We have tried this recovery/.test(n))).toEqual([]);
  });

  it('a genuine provider 400 about an unknown tool is still recovered as tool_name_unknown (the text rule stays for provider words)', async () => {
    const words = 'API error 400: tool "frobnicate" not found';
    await recover(new AgentError(words, 'helper', { code: 'MODEL_CALL_FAILED', provider: classifyProviderError(new Error(words)) }));
    expect(systemNotes().filter((n) => NOT_A_TOOL_NOTE.test(n) || /frobnicate/.test(n)).length).toBeGreaterThan(0);
    expect(agent().status).not.toBe('error');
  });
});
