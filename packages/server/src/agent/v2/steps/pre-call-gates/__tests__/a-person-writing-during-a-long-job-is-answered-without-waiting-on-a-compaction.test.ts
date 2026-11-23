// Round four, sequence L: the owner texted "How far along are you?" during a long job. The next step's
// checkpoint first awaited a full compaction (64 s of paid summaries) and only then parked the job, so his
// answer waited on it. The checkpoint now parks at once; the routine condense runs at the next assembly.
// Real: the database, the owner's message through the dashboard's own door, the checkpoint gate and the
// compaction machinery it no longer calls. Scripted: the summary writer, the vault archive, the socket.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
}));
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => undefined }) }));
const generateSummarySpy = vi.fn(async () => ({ ok: true, text: 'A summary of the older span.', tokenCount: 12 }));
vi.mock('../../../../../memory/summarize.js', () => ({ generateSummary: () => generateSummarySpy() }));
vi.mock('../../../../../vault/archive.js', () => ({
  archiveMessagesBeforeCompaction: vi.fn(() => 'archive-1'), isDreamerIgnored: vi.fn(() => false), getArchiveHighWaterMark: vi.fn(() => null),
}));

import { runMigrations } from '../../../../../db/migrations.js';
import { endTurnContext } from '../../../../turn-context.js';
import { liveTurn } from '../../../__tests__/helpers/live-turn.js';
import { advance, initState } from '../../../state.js';
import { runTurnTimeBudget } from '../turn-budget.js';
import { submitUserMessage } from '../../../../../gateway/routes/chat.js';
import { PRE_CALL_GATES_PHASE, type PreCallGatesContext } from '../index.js';

const AGENT = 'agent-long-job';
const MODEL = 'test-model';

/** A store far over its window: 120 rows of 2,000 tokens on a 128K model. */
function seedOverItsWindow(): void {
  const db = mockDb.current!;
  db.prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'openai', 'api_key')").run();
  db.prepare("INSERT INTO models (id, provider_id, name, api_model_id, is_enabled, capabilities, context_window) VALUES (?, 'p', 'M', ?, 1, '[\"text\"]', 128000)").run(MODEL, MODEL);
  db.prepare("INSERT INTO agents (id, name, status, model_id) VALUES (?, 'Long Job', 'working', ?)").run(AGENT, MODEL);
  const insert = db.prepare('INSERT INTO messages (id, agent_id, role, content, token_count, created_at) VALUES (?, ?, ?, ?, 2000, ?)');
  for (let n = 0; n < 120; n++) insert.run(`row-${n}`, AGENT, n % 2 ? 'assistant' : 'user', `Step ${n} of the inventory`, Date.now() - 600_000 + n);
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  seedOverItsWindow();
  liveTurn(AGENT, { turnNumber: 3, root: { kind: 'ask', id: 'row-0', sourceMessageId: 'row-0' } });
  generateSummarySpy.mockClear();
});
afterEach(() => { endTurnContext(AGENT); mockDb.current?.close(); mockDb.current = null; });

describe('a person writing during a long job is answered without waiting on a compaction', () => {
  it('the owner writes mid-job: the next step parks the job, and no summary is written before it', async () => {
    expect((await submitUserMessage(AGENT, 'How far along are you?')).ok).toBe(true);
    const state = advance(initState({
      agentId: AGENT, contextWindow: 128_000, isAutoRouted: false, configuredModelId: MODEL, turnNumber: 3,
      triggeredByIMessage: false, triggeredByA2AReplyIntent: null, lastUserMessageContent: 'count the gear',
      lastUserMessageId: 'row-0', inboundChannel: 'dashboard', inboundContext: null,
    }), { phase: PRE_CALL_GATES_PHASE, loopCount: 2 });

    const out = await runTurnTimeBudget(state, { agentId: AGENT, turnNumber: 3, configuredModelId: MODEL } as unknown as PreCallGatesContext);

    expect(out).toMatchObject({ directive: 'exit', reason: 'turn-time-budget' });
    expect(mockDb.current!.prepare('SELECT 1 FROM work WHERE agent_id = ? AND next_attempt_at IS NOT NULL').get(AGENT)).toBeTruthy();
    expect(generateSummarySpy).not.toHaveBeenCalled();
    expect((mockDb.current!.prepare('SELECT COUNT(*) AS n FROM summaries WHERE agent_id = ?').get(AGENT) as { n: number }).n).toBe(0);
  });
});
