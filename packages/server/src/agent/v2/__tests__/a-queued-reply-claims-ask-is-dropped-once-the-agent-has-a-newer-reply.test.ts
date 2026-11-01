// BACKLOG 12a — the reply-claims shadow ask: queued behind a running call and not yet sent, it is dropped when its
// agent has produced a NEWER reply (a real signal, no timer), and it is NOT dropped when there is no newer reply.
// Every /v1/systemone call is a scripted fetch.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { __ownerDecisionForTests } from '../../decision-policy.js';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../costs/tracker.js', () => ({ recordCost: () => undefined, getDailySpend: () => 0 }));
const logs: Array<{ msg: string; data?: Record<string, unknown> }> = [];
vi.mock('../../../logger.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => {
    const at = () => (msg: string, data?: Record<string, unknown>) => { logs.push({ msg, data }); };
    return { debug: at(), info: at(), warn: at(), error: at() };
  },
}));

import { runMigrations } from '../../../db/migrations.js';
import { STANDARD_DECISION_MODEL } from '../../../services/local-standard.js';
import { __forgetResidencyForTests, decide } from '../../decide.js';
import { __resetShadowRotationForTests } from '../../decision-shadow.js';
import { askReplyClaims, __forgetReplyClaimsForTests } from '../reply-claims.js';

const AGENT = 'agent-a';
const db = (): Database.Database => mockDb.current!;
const sentReplies: string[] = [];
let release: () => void;
let held: Promise<void>;

beforeEach(() => {
  __ownerDecisionForTests(false);   // these suites test the shadow path itself; the owner's four have their own suite
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  sentReplies.length = 0; logs.length = 0;
  held = new Promise<void>((r) => { release = r; });
  __forgetResidencyForTests(); __forgetReplyClaimsForTests(); __resetShadowRotationForTests();
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', 'http://127.0.0.1:47123', 'none', 1)").run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled) VALUES ('m-decision', 'ollama-local', ?, ?, '["decision"]', 1)`).run(STANDARD_DECISION_MODEL.tag, STANDARD_DECISION_MODEL.tag);
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
    const body = init?.body ?? '';
    const questions = Object.keys((JSON.parse(body) as { questions: object }).questions);
    for (const label of ['first reply', 'second reply']) if (body.includes(label)) sentReplies.push(label);
    if (body.includes('blocker')) await held;
    return Response.json({ answers: Object.fromEntries(questions.map((q) => [q, { noul: 0.5 }])), usage: { input_tokens: 40 } });
  }));
});
afterEach(() => { release(); vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30));
const ask = (messageId: string, reply: string): Promise<void> => askReplyClaims(
  { toolResults: [] } as never,
  { agentId: AGENT, messageId, result: { toolCalls: [] }, counterparty: null, lastUserMessageContent: 'hello' } as never,
  reply,
);
const blocker = (): Promise<unknown> => decide({ x: 'blocker' }, { q: { type: 'noul', instructions: 'Is `x` set?' } }, { purpose: 'p', patienceMs: 60_000 });

describe('a queued reply-claims shadow ask and the agent\'s newer reply', () => {
  it('is dropped, unsent, when the agent has a newer reply; the newer reply\'s ask is sent', async () => {
    const running = blocker();
    await tick();
    await ask('msg-1', 'first reply');
    await ask('msg-2', 'second reply');
    await tick();
    release();
    await running;
    await tick(); await tick();
    expect(sentReplies).toEqual(['second reply']);
    expect(logs.some((l) => l.data?.failure === 'superseded')).toBe(true);
    expect(logs.some((l) => l.msg.includes('reply-claim rows carry no model answer'))).toBe(false);   // not an outage
  });

  it('is NOT dropped when the agent has no newer reply', async () => {
    const running = blocker();
    await tick();
    await ask('msg-1', 'first reply');
    await tick();
    release();
    await running;
    await tick(); await tick();
    expect(sentReplies).toEqual(['first reply']);
    expect(logs.some((l) => l.data?.failure === 'superseded')).toBe(false);
  });
});
