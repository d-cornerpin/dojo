// ════════════════════════════════════════════════════════════════════════════════════════
// TWO A2A ATTACHMENTS SHARING A BASE NAME KEEP BOTH FILES.
//
// `deliverA2AMessage` copies each `attach_paths` entry into the receiver's uploads folder
// and names the copy `a2a_<Date.now()>_<basename>`. The copy loop is synchronous, so two
// attachments with the same base name (`a/report.txt`, `b/report.txt`) land in the same
// millisecond and get the SAME stored name: the second `fs.copyFileSync` overwrites the
// first. The stored `attachments` JSON then holds two entries pointing at one path, and
// the receiver reads the same content twice while the first file is gone.
//
// The door is the real one: `deliverA2AMessage` with real files in two folders on disk,
// and the verdict is read off the stored `attachments` column of the delivered row —
// exactly what the receiver's next turn opens.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
const callModelSpy = vi.fn();
const executeToolSpy = vi.fn();
const googleReadMock = vi.fn();
const googleViews = { current: [] as Array<Record<string, unknown>> };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'a2a-same-named-attachments', 'dojo.db'),
  };
});
vi.mock('../../agent/model.js', async () => {
  const actual = await vi.importActual<typeof import('../../agent/model.js')>('../../agent/model.js');
  return { ...actual, callModel: (...a: unknown[]) => callModelSpy(...a), getContextWindow: () => 200000 };
});
vi.mock('../../agent/tools/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../agent/tools/index.js')>('../../agent/tools/index.js');
  const { classifyToolResult } = await vi.importActual<typeof import('../../agent/tool-outcome.js')>('../../agent/tool-outcome.js');
  return { ...actual, executeTool: async (...a: unknown[]) => classifyToolResult(await executeToolSpy(...a)), getFilteredTools: () => [] };
});
vi.mock('../../agent/runtime.js', () => ({
  injectAttachmentBlocks: vi.fn(), enforceModelCapabilities: () => ({ useTools: true }),
  getAgentRuntime: () => ({ handleMessage: async () => undefined }), clearConsumedOneShotFlags: vi.fn(),
}));
vi.mock('../../agent/pending-attachments.js', async () => {
  const actual = await vi.importActual<typeof import('../../agent/pending-attachments.js')>('../../agent/pending-attachments.js');
  return { ...actual, drainPendingAttachments: () => [], drainPendingAttachmentsWithCaptions: async () => [] };
});
vi.mock('../../costs/tracker.js', () => ({ recordCost: vi.fn() }));
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
vi.mock('../../memory/compaction.js', async () => {
  const actual = await vi.importActual<typeof import('../../memory/compaction.js')>('../../memory/compaction.js');
  return {
    ...actual,
    checkAndCompact: () => Promise.resolve({ leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 }),
    estimateAssembledTokens: () => ({ total: 1000, summaryTokens: 0, freshTailTokens: 1000, freshTailCount: 1, summaryCount: 0 }),
  };
});
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
vi.mock('../../google/client.js', () => ({ googleRead: (...a: unknown[]) => googleReadMock(...a) }));
vi.mock('../../google/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../../google/auth.js')>('../../google/auth.js');
  return { ...actual, listGoogleAccountViews: () => googleViews.current };
});
vi.mock('../../services/image-gen-model.js', () => ({ getEffectiveImageGenModel: () => ({ modelId: 'm', providerId: 'p' }) }));
vi.mock('../../services/image-generation.js', () => ({
  generateImage: async () => ({ ok: false, code: 'HTTP', error: 'HTTP 500 from the image provider' }),
}));

import { runMigrations } from '../../db/migrations.js';
import { deliverA2AMessage } from '../../agent/a2a-transport.js';
import { homeDir } from '../../home.js';

// ── the world ────────────────────────────────────────────────────────────────────────────

const AGENT = 'primary';
const PEER = 'peer-agent';
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

/** Source files live under the private test home, never the real one. */
let srcDir = '';

beforeEach(() => {
  const db = freshDb();
  mockDb.current = db;
  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')`).run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`).run();
  db.prepare(`INSERT INTO agents (id, name, model_id, status, config, classification)
              VALUES ('primary', 'Primary', 'm', 'idle', '{}', 'sensei')`).run();
  db.prepare(`INSERT INTO agents (id, name, model_id, status, config, classification)
              VALUES ('peer-agent', 'Peer', 'm', 'idle', '{}', 'sensei')`).run();
  srcDir = fs.mkdtempSync(path.join(homeDir(), 'a2a-same-name-src-'));
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  if (srcDir) fs.rmSync(srcDir, { recursive: true, force: true });
  srcDir = '';
});

type StoredAttachment = { fileId: string; filename: string; path: string };

describe('two A2A attachments sharing a base name keep both files', () => {
  it('a/report.txt and b/report.txt are stored at two paths, each holding its own bytes', async () => {
    const first = path.join(srcDir, 'folder-a', 'report.txt');
    const second = path.join(srcDir, 'folder-b', 'report.txt');
    fs.mkdirSync(path.dirname(first), { recursive: true });
    fs.mkdirSync(path.dirname(second), { recursive: true });
    fs.writeFileSync(first, 'first');
    fs.writeFileSync(second, 'second');

    const sent = await deliverA2AMessage({
      intent: 'FYI',
      threadId: '7e1f2a3b-0000-4000-8000-0000000000f6',
      requiresResponse: false,
      toAgent: AGENT,
      fromAgent: PEER,
      payload: 'two reports with the same name',
      attachPaths: [first, second],
    });
    expect(sent.delivered).toBe(true);

    const row = mockDb.current!
      .prepare('SELECT attachments FROM messages WHERE id = ?')
      .get(sent.messageId!) as { attachments: string };
    const stored = JSON.parse(row.attachments) as StoredAttachment[];
    expect(stored).toHaveLength(2);

    // Two entries, both named report.txt — what the receiver is shown.
    expect(stored[0].filename).toBe('report.txt');
    expect(stored[1].filename).toBe('report.txt');
    expect(stored[0].fileId).not.toBe(stored[1].fileId);

    // They must NOT share one stored path: one path means the second copy
    // overwrote the first and the receiver reads 'second' twice.
    expect(stored[0].path).not.toBe(stored[1].path);
    expect(fs.readFileSync(stored[0].path, 'utf8')).toBe('first');
    expect(fs.readFileSync(stored[1].path, 'utf8')).toBe('second');
  });
});
