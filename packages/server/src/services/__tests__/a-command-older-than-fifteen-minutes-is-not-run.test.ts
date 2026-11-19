// A command text that waited more than 15 minutes is not run, and the owner is told; a text that is not a command
// (however old) still reaches the agent as chat and is stored.
import { describe, it, expect, vi, beforeAll } from 'vitest';

const runMock = vi.hoisted(() => vi.fn(async (_program: string, _argv: readonly string[]) => ''));
vi.mock('../imessage-run.js', async (orig) => ({ ...(await orig<typeof import('../imessage-run.js')>()), getImsgPath: () => null, runMessagesProgram: runMock }));
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: vi.fn() }));

import { runMigrations } from '../../db/migrations.js';
import { getDb } from '../../db/connection.js';
import { getPrimaryAgentId } from '../../config/platform.js';
import { processInboundIMessage } from '../imessage-bridge.js';

const OWNER = '+15550100198';
const OLD = 'Dojo: That command was sent more than 15 minutes ago, so it was not run. Send it again to run it.';
const MINUTE = 60_000;
const text = (cleanedText: string, sentAtMs?: number) =>
  processInboundIMessage({ sender: OWNER, cleanedText, advanceRowId: null, wakeAgent: false, sentAtMs });

beforeAll(() => {
  runMigrations();
  const db = getDb();
  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')`).run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`).run();
  db.prepare(`INSERT INTO agents (id, name, model_id, status, config, classification)
              VALUES (?, 'Primary', 'm', 'idle', '{}', 'sensei')`).run(getPrimaryAgentId());
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('imessage_approved_senders', ?)")
    .run(JSON.stringify([{ address: OWNER, name: 'Owner', is_primary: true, sharing_level: 'full' }]));
});

describe('a text and its age', () => {
  it('a command twenty minutes old is not run: the owner is told, nothing is stored', async () => {
    expect(await text('status', Date.now() - 20 * MINUTE)).toMatchObject({ outcome: 'command', reply: OLD, messageId: null });
  });

  it('a text that is not a command is chat however old: stored, no reply', async () => {
    const out = await text('kill the lights', Date.now() - 20 * MINUTE);
    expect(out).toMatchObject({ outcome: 'dispatched', reply: null });
    const row = getDb().prepare('SELECT COUNT(*) AS n FROM messages WHERE id = ?').get(out.messageId) as { n: number };
    expect(row.n).toBe(1);
  });

  it('a command ten minutes old is run', async () => {
    expect((await text('status', Date.now() - 10 * MINUTE)).reply).toContain('Status report');
  });

  it('a command of unknown age is run', async () => {
    expect((await text('status')).reply).toContain('Status report');
  });
});
