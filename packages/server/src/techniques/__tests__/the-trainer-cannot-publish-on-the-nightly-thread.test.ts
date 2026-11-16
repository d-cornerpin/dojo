// While the Trainer's turn serves the nightly learning batch it may save new drafts, and nothing else:
// publishing and changing an existing technique are refused. Any other turn, the main agent's included, publishes.

import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => undefined }) }));
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: () => {} }));
vi.mock('../../memory/embeddings.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), refreshEmbedding: vi.fn() }));

const { scratchDojo, MAIN } = await import('../../agent/tools/__tests__/scratch-dojo.js');
const { run } = await scratchDojo('nightly-thread');
const { getDb } = await import('../../db/connection.js');
const { clearPlatformConfigCache } = await import('../../config/platform.js');
const { toolResultOf } = await import('../../agent/tools/index.js');
const { openTurnContext, endTurnContext } = await import('../../agent/turn-context.js');
const { runDistillationCycle } = await import('../distillation.js');

const TRAINER = 'agent-trainer';
const stateOf = (id: string): string | undefined =>
  (getDb().prepare('SELECT state FROM techniques WHERE id = ?').get(id) as { state: string } | undefined)?.state;
const call = async (tool: string, args: Record<string, unknown>) => toolResultOf(await run(TRAINER, tool, args));

beforeAll(async () => {
  const db = getDb();
  db.prepare("INSERT INTO agents (id, name, status, config, classification, spawn_depth, created_by) VALUES (?, 'trainer', 'idle', '{}', 'sensei', 1, ?)").run(TRAINER, MAIN);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('trainer_agent_id', ?)").run(TRAINER);
  clearPlatformConfigCache();
  await call('save_technique', { name: 'owners-own', display_name: 'Owners own', description: 'd', instructions: '# Owners own\nStep one.' });
  await call('save_technique', { name: 'ready-draft', display_name: 'Ready draft', description: 'd', instructions: '# Ready draft\nStep one.' });
  const at = Date.now();
  db.prepare(
    `INSERT INTO lessons (id, agent_id, task_id, cue, lesson, evidence_event_ids, confidence, component, created_at, expires_at)
     VALUES ('l1', ?, 'task-1', 'moving mail to junk', 'use the saved filter first', '[1]', 0.7, 'technique', ?, ?)`,
  ).run(MAIN, at, at + 90 * 24 * 60 * 60 * 1000);
  await runDistillationCycle();
});

const nightlyBatch = () => getDb().prepare("SELECT id, a2a_thread_id AS thread FROM messages WHERE agent_id = ? AND source_agent_id = 'system' ORDER BY seq DESC LIMIT 1").get(TRAINER) as { id: string; thread: string };

function onTheNightlyTurn(): void {
  openTurnContext(TRAINER).triggerMessageId = nightlyBatch().id;
}

/** A turn of `agentId` rooted in the nightly thread, triggered by some later message on it. */
function onTheThreadLater(agentId: string): void {
  const ctx = openTurnContext(agentId);
  ctx.root = { kind: 'a2a', id: nightlyBatch().thread, sourceMessageId: null };
  ctx.triggerMessageId = 'a-later-reply';
}

describe('the Trainer cannot publish on the nightly thread', () => {
  it('refuses publishing and changing an existing technique, and saves a new draft', async () => {
    onTheNightlyTurn();
    try {
      expect((await call('publish_technique', { name: 'ready-draft' })).isError).toBe(true);
      expect((await call('update_technique', { name: 'owners-own', instructions: '# Owners own\nRewritten.' })).isError).toBe(true);
      expect((await call('save_technique', { name: 'new-pub', display_name: 'New pub', description: 'd', instructions: '# New\nx', publish: true })).isError).toBe(true);
      expect((await call('save_technique', { name: 'new-draft', display_name: 'New draft', description: 'd', instructions: '# New\nx' })).isError).toBe(false);
    } finally {
      endTurnContext(TRAINER);
    }
    expect(stateOf('ready-draft')).toBe('draft');
    expect(stateOf('new-pub')).toBeUndefined();
    expect(stateOf('new-draft')).toBe('draft');
  });

  it('the main agent publishes on a turn rooted in the nightly thread', async () => {
    onTheThreadLater(MAIN);
    try {
      expect((await toolResultOf(await run(MAIN, 'publish_technique', { name: 'owners-own' }))).isError).toBe(false);
    } finally {
      endTurnContext(MAIN);
    }
    expect(stateOf('owners-own')).toBe('published');
  });

  it('the Trainer publishes on a later daytime turn on that thread', async () => {
    onTheThreadLater(TRAINER);
    try {
      expect((await call('publish_technique', { name: 'ready-draft' })).isError).toBe(false);
    } finally {
      endTurnContext(TRAINER);
    }
    expect(stateOf('ready-draft')).toBe('published');
  });
});
