// ════════════════════════════════════════════════════════════════════════════════════════
// THE HAND-BACK REACHES THE MODEL WHOLE, AND ONLY ON THE TURN THAT SERVES THAT ASK.
//
// Review B1/M1 on proof-fix-f: the hand-back was an events-lane notice. The lane gists every
// engine row to 400 characters, so the part that prevents a second answer (what the dead turn
// already did, a send it died inside included) never reached the model; and the lane
// is shown in every conversation's turn, so a contact's turn saw the owner's message.
//
// DRIVEN through the engine's real turn entry (`runV2Turn`) with the REAL assembler; only the
// model is scripted, and what the model "saw" is read off the arguments the turn handed to
// `callModel`. Fixtures are fictional.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
const callModelSpy = vi.fn();

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-hand-back-render', 'dojo.db'),
  };
});
vi.mock('../../agent/model.js', async () => {
  const actual = await vi.importActual<typeof import('../../agent/model.js')>('../../agent/model.js');
  return { ...actual, callModel: (...a: unknown[]) => callModelSpy(...a), getContextWindow: () => 200000 };
});
vi.mock('../../agent/tools/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../agent/tools/index.js')>('../../agent/tools/index.js');
  return { ...actual, getFilteredTools: () => [] };
});
vi.mock('../../agent/runtime.js', () => ({
  injectAttachmentBlocks: vi.fn(), enforceModelCapabilities: () => ({ useTools: true }),
  getAgentRuntime: () => ({ handleMessage: async () => undefined }), clearConsumedOneShotFlags: vi.fn(),
}));
vi.mock('../../agent/pending-attachments.js', async () => {
  const actual = await vi.importActual<typeof import('../../agent/pending-attachments.js')>('../../agent/pending-attachments.js');
  return { ...actual, drainPendingAttachments: () => [], drainPendingAttachmentsWithCaptions: async () => [] };
});
vi.mock('../../costs/tracker.js', async () => ({ ...(await vi.importActual<typeof import('../../costs/tracker.js')>('../../costs/tracker.js')), recordCost: vi.fn() }));
vi.mock('../../memory/embeddings.js', () => ({
  queueEmbedding: vi.fn(), generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  storeEmbedding: async () => { /* not exercised */ }, refreshEmbedding: () => { /* not exercised */ },
}));
vi.mock('../../memory/vector-search.js', () => ({ vectorSearch: async () => [], hybridSearch: async () => [] }));
vi.mock('../../services/imessage-bridge.js', () => ({
  isAwaitingIMResponse: () => false, clearIMResponseFlag: vi.fn(),
  getPendingIMSenderRaw: () => null, stripSystemTags: (s: string) => s,
  parseSafeSenders: (raw: string | null) => (raw ? (JSON.parse(raw) as Array<{ address: string }>) : []),
  sendIMessageWithAttachment: vi.fn(), addressesMatch: (a: string, b: string) => a.toLowerCase() === b.toLowerCase(),
  getInboundSenderFor: () => null, sendAlert: vi.fn(),
  getTurnScopedImRecipient: () => null, getDefaultSender: () => null,
}));
vi.mock('../../config/platform.js', () => ({
  clearPlatformConfigCache: vi.fn(),
  getOwnerName: () => 'TestUser', getPrimaryAgentId: () => 'primary', getPrimaryAgentName: () => 'Primary',
  getPMAgentId: () => 'pm', getPMAgentName: () => 'PM',
  getTrainerAgentId: () => 'trainer', getTrainerAgentName: () => 'Trainer',
  isSetupCompleted: () => true, setPlatformConfig: vi.fn(),
  isPrimaryAgent: (id: string) => id === 'primary', isPMAgent: (id: string) => id === 'pm',
  isTrainerAgent: (id: string) => id === 'trainer',
  getHealerAgentId: () => 'healer', getHealerAgentName: () => 'Healer', isHealerAgent: (id: string) => id === 'healer',
  getDreamerAgentId: () => 'dreamer', getDreamerAgentName: () => 'Dreamer', isDreamerAgent: (id: string) => id === 'dreamer',
  HOUSEHOLD_AGENT_IDS_KEY: 'household_agent_ids', getHouseholdAgentIds: () => [],
  isPermanentAgent: (id: string) => id === 'primary' || id === 'dreamer', isSystemServiceAgent: () => false,
  getSystemServiceAgentIds: () => [], getDashboardHiddenAgentIds: () => new Set<string>(), isDashboardHiddenAgent: () => false,
}));
vi.mock('../../agent/spawner.js', () => ({ checkTimeouts: vi.fn() }));
vi.mock('../../healer/injury-recovery.js', () => ({ onAgentInjured: vi.fn(), onAgentRecovered: vi.fn(), rehydrateInjuredAgents: vi.fn() }));
vi.mock('../../vault/maintenance.js', () => ({ isContextOverflowError: () => false, recoverDreamerFromContextOverflow: async () => false }));
vi.mock('../../services/capabilities.js', () => ({ removeCapability: vi.fn(), getModelCapabilities: () => ['tools'] }));
vi.mock('../../services/presence.js', () => ({
  getPresence: () => 'present', maybeForwardToImessage: vi.fn(), isImessageConfigured: () => false,
  isImessageEnabled: () => false, setPresence: vi.fn(),
}));
vi.mock('../../router/scorer.js', () => ({ scoreQuery: () => ({ tier: 'standard', scores: [], rawScore: 0, confidence: 0.5, latencyMs: 0 }) }));
vi.mock('../../router/selector.js', () => ({ selectModel: vi.fn(), logRouterDecision: vi.fn(), getSystemModel: () => null }));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  setLogLevel: vi.fn(), setLogBroadcast: vi.fn(), readLogEntries: () => [],
}));
import { runV2Turn } from '../../agent/v2/loop.js';
import { runMigrations } from '../../db/migrations.js';
import { submitUserMessage } from '../../gateway/routes/chat.js';
import { insertMessage, insertMessageIfAbsent } from '../../memory/message-store.js';
import { askIdForMessage, claimAsk, stampClaimingTurn } from '../store.js';
import { reconcileOrphanedClaims } from '../orphaned-claims.js';
import { resetWorkingAgentsToIdleAtBoot } from '../../agent/agent-status.js';

const AGENT = 'primary';
const OWNER_ASK = 'Could you book the roofer for Thursday and confirm the quote with them?';
let image: Buffer | null = null;
function freshDb(): Database.Database {
  if (!image) {
    const s = new Database(':memory:');
    mockDb.current = s;
    runMigrations();
    image = s.serialize();
    s.close();
  }
  const db = new Database(image);
  db.pragma('foreign_keys = ON');
  return db;
}

type Wire = { role: string; content: unknown };
const seen: Wire[][] = [];
const textOf = (m: Wire): string => typeof m.content === 'string' ? m.content
  : (m.content as Array<Record<string, unknown>>).map((b) => (b.type === 'text' ? String(b.text) : JSON.stringify(b))).join('\n');
/** Everything the model was handed on one turn, as one string. */
async function turnSees(reply: string): Promise<string> {
  const before = seen.length;
  callModelSpy.mockImplementation(async (params: { messages: Wire[] }) => {
    seen.push(JSON.parse(JSON.stringify(params.messages)) as Wire[]);
    return { content: reply, toolCalls: [], inputTokens: 1, outputTokens: 1, stopReason: 'end_turn' };
  });
  await runV2Turn(AGENT);
  return seen.slice(before).map((call) => call.map(textOf).join('\n\n')).join('\n\n');
}

/** The owner's ask, picked up by a turn that sent an email, died inside a text, and died with the process. */
async function ownerAskStrandedByADeadTurn(): Promise<string> {
  const r = await submitUserMessage(AGENT, OWNER_ASK);
  expect(r.ok).toBe(true);
  const id = (mockDb.current!.prepare("SELECT id FROM messages WHERE role = 'user' AND content LIKE '%book the roofer%'").get() as { id: string }).id;
  claimAsk(askIdForMessage(id), AGENT);
  stampClaimingTurn(askIdForMessage(id), 900);
  mockDb.current!.prepare(
    `INSERT INTO turns (agent_id, turn_number, kind, root_kind, root_id, source_message_id, started_at, answered, effectful_calls)
     VALUES (?, 900, 'user', 'ask', ?, ?, datetime('now'), 0, 1)`,
  ).run(AGENT, id, id);
  insertMessageIfAbsent({ id: 'u-900', agentId: AGENT, role: 'assistant', turnNumber: 900,
    content: JSON.stringify([{ type: 'tool_use', id: 'c900', name: 'gmail_send', input: { to: 'roofer@example.com', subject: 'Thursday booking' } }]) } as never);
  insertMessageIfAbsent({ id: 'r-900', agentId: AGENT, role: 'tool', turnNumber: 900,
    content: JSON.stringify([{ type: 'tool_result', tool_use_id: 'c900', content: 'sent', is_error: false }]) } as never);
  insertMessageIfAbsent({ id: 'u-901', agentId: AGENT, role: 'assistant', turnNumber: 900,
    content: JSON.stringify([{ type: 'tool_use', id: 'c901', name: 'imessage_send', input: { recipient: '+15550000', message: 'Booked the roofer for Thursday at nine.' } }]) } as never);
  mockDb.current!.prepare("UPDATE agents SET status = 'working' WHERE id = ?").run(AGENT);
  // The restart: the boot sweep closes the dead turn, the reconcile hands the ask back.
  resetWorkingAgentsToIdleAtBoot();
  expect(reconcileOrphanedClaims().reArmed).toBe(1);
  return id;
}

const FACTS = [
  'gmail_send', 'roofer@example.com',                                        // what the dead turn already did
  'may not have gone', 'imessage_send', '+15550000', 'Booked the roofer for Thursday at nine.', // the send it died inside
  'book the roofer for Thursday', 'received', 'ago',                         // the message and its age
  'Answer it now',                                                           // the instruction
];

beforeEach(() => {
  const db = freshDb();
  mockDb.current = db;
  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')`).run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`).run();
  db.prepare(`INSERT INTO agents (id, name, model_id, status, config, classification)
              VALUES ('primary', 'Primary', 'm', 'idle', '{}', 'sensei')`).run();
  seen.length = 0;
  callModelSpy.mockReset();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('the hand-back facts, in the real model context', () => {
  it('the turn that serves the handed-back ask is given every fact, whole', async () => {
    await ownerAskStrandedByADeadTurn();
    const wire = await turnSees('I will check whether the text reached them before doing anything else.');
    for (const f of FACTS) expect(wire, `the serving turn's context is missing: ${f}`).toContain(f);
  });

  it('another conversation\'s turn sees the owner\'s conversation labelled as his, and none of the hand-back', async () => {
    await ownerAskStrandedByADeadTurn();
    const owner = await turnSees('Checking whether the text reached them first.');
    for (const f of FACTS) expect(owner, `the serving turn's context is missing: ${f}`).toContain(f);
    // Then a contact writes. Their turn sees the owner's conversation, labelled as his; the hand-back's
    // instructions belong to the turn that serves his request and are not on this one.
    mockDb.current!.prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES ('conv-contact', ?, 'imessage', '+15550100')`).run(AGENT);
    insertMessage({
      id: 'm-contact', agentId: AGENT, role: 'user', content: 'Hi, is the garden party still on Saturday?',
      lane: 'owner', channel: 'imessage', senderId: '+15550100', authorized: true, conversationId: 'conv-contact',
      inboundMeta: JSON.stringify({ channel: 'imessage', relation: 'known_contact', sender: '+15550100', authorized: true }),
    } as never);
    const wire = await turnSees('Yes, Saturday at two.');
    expect(wire, 'this turn must be the contact\'s').toContain('garden party');
    expect(wire, 'the owner\'s request is in view, labelled as his').toMatch(/dashboard conversation with TestUser\] Could you book the roofer/);
    for (const f of ['may not have gone', 'Answer it now']) {
      expect(wire, `a contact's turn was handed the hand-back: ${f}`).not.toContain(f);
    }
  });
});

describe('the inherited-backlog notice (review R3-3): the list only on the turn it drives', () => {
  /** An owner ask an older build stranded weeks ago (its turn closed by a boot long since). */
  async function inheritedOwnerAsk(): Promise<void> {
    const r = await submitUserMessage(AGENT, 'Can you find the warranty card for the dishwasher?');
    expect(r.ok).toBe(true);
    const id = (mockDb.current!.prepare("SELECT id FROM messages WHERE content LIKE '%warranty card%'").get() as { id: string }).id;
    mockDb.current!.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(Date.now() - 9 * 86_400_000, id);
    claimAsk(askIdForMessage(id), AGENT);
    stampClaimingTurn(askIdForMessage(id), 800);
    mockDb.current!.prepare(
      `INSERT INTO turns (agent_id, turn_number, kind, root_kind, root_id, started_at, ended_at, exit_reason, answered)
       VALUES (?, 800, 'user', 'ask', ?, datetime('now', '-9 days'), datetime('now', '-9 days'), 'terminated', 0)`,
    ).run(AGENT, id);
    reconcileOrphanedClaims({ inheritedBacklog: true });
    mockDb.current!.prepare("UPDATE messages SET next_attempt_at = ? WHERE origin_intent = 'owed_messages_inherited'").run(Date.now() - 1000);   // its three-minute wait is over
  }

  it('the stored notice row carries no personal content', async () => {
    await inheritedOwnerAsk();
    const stored = (mockDb.current!.prepare("SELECT content FROM messages WHERE origin_intent = 'owed_messages_inherited'").get() as { content: string }).content;
    expect(stored).not.toContain('warranty');
    expect(stored).not.toContain('dishwasher');
  });

  it('the turn the notice drives is given the list whole; a later contact turn sees only the owner\'s labelled conversation', async () => {
    await inheritedOwnerAsk();
    const engine = await turnSees('I will look at these and decide.');
    expect(engine, 'the driven turn must see the list').toContain('dishwasher');
    expect(engine).toMatch(/from the owner/);
    expect(engine).toMatch(/9 days ago/);
    mockDb.current!.prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES ('conv-c2', ?, 'imessage', '+15550177')`).run(AGENT);
    insertMessage({
      id: 'm-c2', agentId: AGENT, role: 'user', content: 'Is the bake sale on Sunday?',
      lane: 'owner', channel: 'imessage', senderId: '+15550177', authorized: true, conversationId: 'conv-c2',
      inboundMeta: JSON.stringify({ channel: 'imessage', relation: 'known_contact', sender: '+15550177', authorized: true }),
    } as never);
    const wire = await turnSees('Yes, Sunday at ten.');
    expect(wire, 'this turn must be the contact\'s').toContain('bake sale');
    expect(wire, 'the owner\'s old request is in view, labelled as his').toMatch(/dashboard conversation with TestUser\] Can you find the warranty card/);
    for (const f of ['from the owner', '9 days ago']) expect(wire, `a contact's turn was handed the notice: ${f}`).not.toContain(f);
  });
});
