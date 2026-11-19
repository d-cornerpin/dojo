// With voice mode on, a turn is read aloud when the request it answers was spoken: a spoken ask to any
// agent, and an agent woken after an approval inside a spoken request. A typed question or a text from
// another channel stays silent. The turn's root is set the way preflight sets it; the decision reads the
// stored request.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { WsEvent } from '@dojo/shared';

const bus = new Set<(e: WsEvent) => void>();
const emit = (e: WsEvent): void => { for (const h of [...bus]) h(e); };
const spoken: string[] = [];
const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('hume', () => ({ HumeClient: class {} }));
vi.mock('../hume-engine.js', () => ({ isHumeConfigured: () => false, HumeStreamSession: class {} }));
vi.mock('../tts-service.js', async (orig) => ({
  ...(await orig<typeof import('../tts-service.js')>()),
  loadKokoro: async () => ({}),
  isKokoroLoaded: () => true,
  async* synthesizeClauseStream(queue: AsyncIterable<string>) {
    for await (const c of queue) { spoken.push(c); yield { text: c, pcm: new Float32Array(4), sampleRate: 24000 }; }
  },
}));
vi.mock('../stt-service.js', () => ({
  transcribeBuffer: async () => ({ text: '', durationMs: 1 }), ensureSttReady: async () => {}, DEFAULT_STT_MODEL_KEY: 'moonshine-base',
  parseSttModelKey: () => ({ kind: 'moonshine' }), pcmFloatToWav: () => Buffer.from('wav'),
}));
vi.mock('../smart-turn.js', () => ({ predictTurnComplete: async () => null, TURN_COMPLETE_THRESHOLD: 0.5, warmUpSmartTurn: async () => {} }));
vi.mock('../custom-voices.js', () => ({ checkCustomVoiceUsable: () => ({ ok: true }) }));
vi.mock('../../agent/runtime.js', () => ({ preemptAgentForUrgentMessage: () => {} }));
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (e: WsEvent) => emit(e),
  onBroadcast: (h: (e: WsEvent) => void) => { bus.add(h); return () => { bus.delete(h); }; },
  stampPersistedRow: (e: unknown) => e,
}));
vi.mock('../../gateway/routes/chat.js', () => ({ submitUserMessage: vi.fn() }));
vi.mock('../../config/loader.js', () => ({ getJwtSecret: () => 'secret' }));
vi.mock('../../agent/v2/outbound.js', () => ({ recordAtDoor: () => ({}), recordedId: () => '' }));
vi.mock('../../db/connection.js', () => ({ getDb: () => mockDb.current!, closeDb: vi.fn(), getDbPath: () => ':memory:' }));
vi.mock('../../logger.js', () => {
  const noop = (): void => {};
  return { createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }) };
});

const jwt = (await import('jsonwebtoken')).default;
const { runMigrations } = await import('../../db/migrations.js');
const { openTurnContext, endTurnContext } = await import('../../agent/turn-context.js');
const { engineEventRoot } = await import('../../agent/v2/work-lineage.js');
const { verifyAndOpenVoiceSession, closeVoiceSession } = await import('../voice-ws.js');

const ws = { send: () => {}, close: () => {} };
let n = 0;

/** An owner message as its channel stores it. */
function asked(agentId: string, channel: string): string {
  const id = `m${++n}`;
  mockDb.current!.prepare(
    `INSERT INTO messages (id, agent_id, role, content, channel, lane, created_at) VALUES (?, ?, 'user', 'a request', ?, 'owner', ?)`,
  ).run(id, agentId, channel, Date.now() + n);
  return id;
}

/** One turn of `agentId` rooted as preflight roots it, replying with `text`; resolves with what was read aloud. */
async function turnReplies(agentId: string, root: { kind: 'ask' | 'engine'; id: string; sourceMessageId: string | null }, text: string): Promise<string[]> {
  spoken.length = 0;
  verifyAndOpenVoiceSession(ws as never, `/voice?token=${jwt.sign({ userId: 'u1' }, 'secret')}&agentId=${agentId}`);
  const bag = openTurnContext(agentId);
  bag.root = root;
  emit({ type: 'chat:chunk', agentId, messageId: `r${n}`, content: text, done: true });
  emit({ type: 'agent:status', agentId, status: 'idle' } as WsEvent);
  endTurnContext(agentId);
  await new Promise((r) => setTimeout(r, 30));
  closeVoiceSession(ws as never);
  return [...spoken];
}
const askRoot = (id: string) => ({ kind: 'ask' as const, id, sourceMessageId: id });

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  for (const id of ['agent-1', 'helper-agent']) {
    mockDb.current.prepare(`INSERT INTO agents (id, name, model_id, status, created_at, updated_at)
      VALUES (?, ?, NULL, 'idle', datetime('now'), datetime('now'))`).run(id, id);
  }
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('a reply to a text is not spoken while voice is on', () => {
  it('a spoken ask to an agent that is not the main agent is read aloud', async () => {
    const ask = asked('helper-agent', 'voice');
    expect(await turnReplies('helper-agent', askRoot(ask), 'Milk is on the list.')).toEqual(['Milk is on the list.']);
  });

  it('an agent woken after an approval, in a request that was spoken, is read aloud', async () => {
    const ask = asked('agent-1', 'voice');
    const root = engineEventRoot({ id: 'ev1', runId: null, originIntent: 'a2a_request', rootKind: 'ask', rootId: ask });
    expect(await turnReplies('agent-1', root, 'The flights are booked.')).toEqual(['The flights are booked.']);
  });

  it('a typed question and a text from another channel stay silent', async () => {
    expect(await turnReplies('agent-1', askRoot(asked('agent-1', 'dashboard')), 'Typed answer.')).toEqual([]);
    expect(await turnReplies('agent-1', askRoot(asked('agent-1', 'imessage')), 'The dentist is booked.')).toEqual([]);
  });
});
