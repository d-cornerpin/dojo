// A confirmed owner email's command runs once, however often a poll reads that mail again.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as w from './mail-world.js';

vi.mock('../../db/connection.js', async () => (await import('./mail-world.js')).dbModule());
vi.mock('../../gateway/ws.js', async () => (await import('./mail-world.js')).wsModule());
vi.mock('../../agent/runtime.js', async () => (await import('./mail-world.js')).runtimeModule());
vi.mock('../../google/client.js', async () => (await import('./mail-world.js')).googleClientModule());
vi.mock('../../microsoft/client.js', async () => (await import('./mail-world.js')).graphClientModule());

// Loaded at file level, so no case pays for the load.
import '../../db/migrations.js';
import '../gmail-watcher.js';
import '../outlook-watcher.js';

beforeEach(() => w.freshWorld());
const { runCommand } = vi.hoisted(() => ({ runCommand: vi.fn(async (_words: string) => 'done') }));
vi.mock('../imessage-commands.js', () => ({ handleConfirmedOwnerEmailWords: runCommand }));

const ownerMail = (i: number, at: number): w.Mail => ({
  id: `c-${i}`, from: 'Owner <owner@example.com>', subject: 'Command', snippet: 'status', to: 'agent.box@example.com', at, body: 'status',
  headers: [{ name: 'Message-ID', value: `<c-${i}@example.com>` }, { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass (p=NONE) header.from=example.com' }],
});

beforeEach(async () => {
  runCommand.mockClear();
  await w.addMailbox('gmail', 'user', 'owner@example.com', 'acct-owner', null, false);
  await w.addMailbox('gmail', 'agent', 'agent.box@example.com', 'agent', 6 * 3600_000);
});

describe('an owner mail command runs once however often it is read', () => {
  it('a 250-mail backlog, then a poll that lists the newest 20 again: no command runs twice', async () => {
    // Thirty seconds apart, so the newest twenty or so sit inside the next poll's 15-minute look back.
    const base = Date.now() - 250 * 30_000;
    w.inboxHolds('gmail', Array.from({ length: 250 }, (_, i) => ownerMail(i, base + i * 30_000)));
    await w.poll('gmail');
    expect(runCommand).toHaveBeenCalledTimes(250);
    await w.poll('gmail');
    expect(runCommand).toHaveBeenCalledTimes(250);
  });

  it('a command mail read again after its processed-list save was lost runs once', async () => {
    w.inboxHolds('gmail', [ownerMail(1, Date.now() - 60_000)]);
    await w.poll('gmail');
    w.rows(`DELETE FROM config WHERE key = 'gmail_notified_ids' RETURNING key`);
    await w.poll('gmail');
    expect(runCommand).toHaveBeenCalledTimes(1);
  });
});
