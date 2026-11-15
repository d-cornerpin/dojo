// ════════════════════════════════════════════════════════════════════════════════════════
// AN A2A ATTACHMENT IS FILED UNDER THE CATEGORY THE RECEIVER ACTUALLY READS.
//
// The receiver's turn builds a document block only for stored category 'pdf'
// (`runtime.ts` filters `a.category === 'pdf'`), so a PDF sent through
// `send_to_agent attach_paths` that gets filed under anything else is invisible to the
// model no matter how well the copy went. The same row also carries the mime a model
// sees, so `.jpg` must not be stored as the fake `image/jpg`.
//
// The door is the real one: `deliverA2AMessage` with real files on disk, and the
// verdict is read off the stored `attachments` column of the delivered row — exactly
// what the next turn reads.
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
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'a2a-attachment-categories', 'dojo.db'),
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
  isAwaitingIMResponse: () => false, clearIMResponseFlag: vi.fn(), sendResponseViaIMessage: vi.fn(),
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
    estimateAssembledTokens: () => ({ total: 1000, summaryTokens: 0, freshTailTokens: 1000, briefTokens: 0, freshTailCount: 1, summaryCount: 0 }),
  };
});
vi.mock('../../config/platform.js', () => ({
  clearPlatformConfigCache: vi.fn(), getPlatformName: () => 'Dojo',
  getOwnerName: () => 'TestUser', getPrimaryAgentId: () => 'primary', getPrimaryAgentName: () => 'Primary',
  getPMAgentId: () => 'pm', getPMAgentName: () => 'PM',
  getTrainerAgentId: () => 'trainer', getTrainerAgentName: () => 'Trainer',
  isSetupCompleted: () => true, setPlatformConfig: vi.fn(), getAllPlatformConfig: () => ({}),
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
  srcDir = fs.mkdtempSync(path.join(homeDir(), 'a2a-attach-src-'));
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  if (srcDir) fs.rmSync(srcDir, { recursive: true, force: true });
  srcDir = '';
});

type StoredAttachment = { filename: string; mimeType: string; category: string; path: string };

describe('an A2A attach_paths delivery files each extension under the category the receiver reads', () => {
  it('a .pdf is stored as pdf/application/pdf, and every other extension keeps its true mime', async () => {
    const sources: Array<[string, string]> = [
      ['a.pdf', '%PDF-1.4\n'],
      ['b.jpg', 'not really a jpeg'],
      ['c.png', 'not really a png'],
      ['d.mp3', 'not really mp3'],
      ['e.txt', 'plain text'],
    ];
    const attachPaths = sources.map(([name, bytes]) => {
      const p = path.join(srcDir, name);
      fs.writeFileSync(p, bytes);
      return p;
    });

    const sent = await deliverA2AMessage({
      intent: 'FYI',
      threadId: '7e1f2a3b-0000-4000-8000-0000000000f5',
      requiresResponse: false,
      toAgent: AGENT,
      fromAgent: PEER,
      payload: 'fyi',
      attachPaths,
    });
    expect(sent.delivered).toBe(true);

    const row = mockDb.current!
      .prepare('SELECT attachments FROM messages WHERE id = ?')
      .get(sent.messageId!) as { attachments: string };
    const stored = JSON.parse(row.attachments) as StoredAttachment[];
    const byName: Record<string, StoredAttachment> = Object.fromEntries(stored.map((a) => [a.filename, a]));

    expect(byName['a.pdf']).toMatchObject({ category: 'pdf', mimeType: 'application/pdf' });
    expect(byName['b.jpg']).toMatchObject({ category: 'image', mimeType: 'image/jpeg' });
    expect(byName['c.png']).toMatchObject({ category: 'image', mimeType: 'image/png' });
    expect(byName['d.mp3']).toMatchObject({ category: 'audio', mimeType: 'audio/mpeg' });
    expect(byName['e.txt']).toMatchObject({ category: 'unknown', mimeType: 'application/octet-stream' });

    // Every stored entry points at a real file under the receiver's uploads folder.
    const uploadsDir = path.join(homeDir(), '.dojo', 'uploads', AGENT);
    expect(stored).toHaveLength(5);
    for (const a of stored) {
      expect(fs.existsSync(a.path)).toBe(true);
      expect(path.resolve(path.dirname(a.path))).toBe(path.resolve(uploadsDir));
    }
  });
});
