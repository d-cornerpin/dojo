// ════════════════════════════════════════════════════════════════════════════════════════
// t224 — A TURN THAT THREW STILL ENDS THE COMMANDS IT LEFT RUNNING.
//
// t203's header says the process-tree binding serves "the stop (and the turn's own teardown, for a
// call the executor abandoned)". The teardown reaches children today only because they sit in the
// abort registry, which is the thing t224 takes them out of. This clause pins the behaviour so the
// move cannot drop it: a thrown turn's recovery arm ends a command still running for that agent,
// and does not touch another agent's.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const { mockDb } = vi.hoisted(() => ({ mockDb: { current: null as Database.Database | null } }));

vi.mock('../../../../../db/connection.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../../db/connection.js')>('../../../../../db/connection.js');
  return {
    ...actual,
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
  };
});
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

import { runMigrations } from '../../../../../db/migrations.js';
import { advance, initState } from '../../../state.js';
import { openTurnContext, endTurnContext } from '../../../../turn-context.js';
import { TEARDOWN_PHASE, runTurnRecovery, type TeardownContext } from '../index.js';
import { runWithToolCallId } from '../../../../turn-state.js';
import { attachCallCapability, mintCallCapability, type ResourceGrant } from '../../../../effects/capability.js';
import { spawnAuthorized } from '../../../../effects/proc.js';
import { activeAbortControllers } from '../../../../shared-state.js';

vi.setConfig({ testTimeout: 30_000 });

const AGENT = 'primary';
const OTHER = 'someone-else';
const started: number[] = [];

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

function command(agentId: string): number {
  const grants: ResourceGrant[] = [{ kind: 'proc', program: '/bin/zsh', display: '/bin/zsh' } as ResourceGrant];
  const pid = runWithToolCallId(agentId, 'call-1', () => {
    attachCallCapability(mintCallCapability({ agentId, tool: 'shell', callId: 'call-1', grants }));
    return spawnAuthorized('/bin/zsh', ['-c', 'sleep 59; wait']).pid as number;
  });
  started.push(pid as number);
  return pid as number;
}

beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')`).run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`).run();
  db.prepare(`INSERT INTO agents (id, name, model_id, status, config, classification) VALUES (?, 'Primary', 'm', 'idle', '{}', 'sensei')`).run(AGENT);
  db.prepare(`INSERT INTO turns (agent_id, turn_number, kind, started_at, answered) VALUES (?, 1, 'user', datetime('now'), 0)`).run(AGENT);
  endTurnContext(AGENT);
});

afterEach(() => {
  for (const pid of started) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
  started.length = 0;
  activeAbortControllers.clear();
  mockDb.current?.close();
  mockDb.current = null;
});

describe('t224: the thrown-turn recovery arm ends a command the turn left running', () => {
  it('ends this agent\'s command and leaves another agent\'s alone', async () => {
    const mine = command(AGENT);
    const theirs = command(OTHER);
    const turnCtx = openTurnContext(AGENT);
    turnCtx.turnNumber = 1;
    const ctx: TeardownContext = {
      agentId: AGENT, turnCtx, turnNumber: 1, db: mockDb.current!,
      chosenConvKey: null, chosenConversationId: null, lastAssembledAtIso: null, terminalAnswerRowId: null,
      triggerWorkId: null, toolPhaseEndedBySpinBrake: false, toolLoopCapReached: false, turnInjectedTechniqueId: null,
      counterparty: { kind: 'user' } as TeardownContext['counterparty'],
      isA2ATurn: false, isEngineTurn: false, turnStartedAt: new Date().toISOString(),
      inboundChannel: 'dashboard', inboundContext: null,
      reArmIfStrandedNoAnswer: vi.fn(), stopStatusHeartbeat: vi.fn(),
    };
    const state = advance(initState({
      agentId: AGENT, contextWindow: 200000, isAutoRouted: false, configuredModelId: 'm', turnNumber: 1,
      triggeredByIMessage: false, triggeredByA2AReplyIntent: null, lastUserMessageContent: null,
      lastUserMessageId: null, inboundChannel: 'dashboard', inboundContext: null, pendingTechniqueAck: null,
    }), { phase: TEARDOWN_PHASE });

    await runTurnRecovery(state, ctx, new Error('boom'));

    expect(await until(() => !alive(mine), 6000), 'the thrown turn left its command running').toBe(true);
    expect(alive(theirs), 'another agent\'s command was cut').toBe(true);
  });
});
