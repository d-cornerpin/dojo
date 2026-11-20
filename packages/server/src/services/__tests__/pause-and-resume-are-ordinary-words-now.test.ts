// "pause" and "resume" are no longer commands: from the owner they are ordinary chat, by text or in a confirmed owner email.
import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '../../db/migrations.js';
import { getDb } from '../../db/connection.js';
import { getPrimaryAgentId } from '../../config/platform.js';
import { handleIMCommand, handleConfirmedOwnerEmailWords } from '../imessage-commands.js';

const OWNER = '+15550100198';

beforeAll(() => {
  runMigrations();
  getDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('imessage_approved_senders', ?)")
    .run(JSON.stringify([{ address: OWNER, name: 'Owner', is_primary: true, sharing_level: 'full' }]));
  getDb().prepare(`INSERT OR REPLACE INTO agents (id, name, status, classification, created_at, updated_at)
    VALUES (?, 'Prime', 'idle', 'sensei', datetime('now'), datetime('now'))`).run(getPrimaryAgentId());
});

describe('pause and resume from the owner', () => {
  it('a text is not a command: no reply, and the main agent\'s status is untouched', async () => {
    expect(await handleIMCommand('pause', OWNER)).toBeNull();
    expect(await handleIMCommand('resume', OWNER)).toBeNull();
    const row = getDb().prepare('SELECT status FROM agents WHERE id = ?').get(getPrimaryAgentId()) as { status: string };
    expect(row.status).toBe('idle');
  });

  it('a confirmed owner email saying them is not a command either', async () => {
    expect(await handleConfirmedOwnerEmailWords('pause')).toBeNull();
    expect(await handleConfirmedOwnerEmailWords('resume')).toBeNull();
  });
});
