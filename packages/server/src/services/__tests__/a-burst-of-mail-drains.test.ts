// A burst larger than one poll's bound, inside the look-back window or all at one received time, drains in a few
// polls: every mail is stored once and none is read again for ever.
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

const burst = (at: (i: number) => number): w.Mail[] =>
  Array.from({ length: 600 }, (_, i) => ({ id: `x-${i}`, from: 'Pat <pat@example.com>', subject: `Note ${i}`, snippet: 'hi', to: 'agent.box@example.com', at: at(i) }));

async function drains(p: w.Provider, mail: w.Mail[]): Promise<void> {
  w.inboxHolds(p, mail);
  await w.poll(p, 3);
  const stored = w.rows(`SELECT external_message_id AS id, COUNT(*) AS n FROM messages WHERE external_message_id LIKE 'x-%' GROUP BY 1`);
  expect(stored).toHaveLength(600);
  expect(stored.every((r) => r.n === 1)).toBe(true);
  // Nothing is left to read: one more poll reads no mail and wakes nothing.
  const wakes = w.wake.mock.calls.length;
  const reads = (p === 'gmail' ? w.googleRead : w.msGraphRead).mock.calls.length;
  await w.poll(p);
  expect(w.wake.mock.calls.length).toBe(wakes);
  if (p === 'gmail') expect(w.googleRead.mock.calls.slice(reads).some((c) => String(c[0]).includes('format=metadata'))).toBe(false);
}

describe('a burst of mail drains', () => {
  it.each(['gmail', 'outlook'] as const)('%s: 600 mails over 5 minutes', async (p) => {
    await w.addMailbox(p, 'agent', 'agent.box@example.com', 'agent', 6 * 60_000);
    const base = Date.now() - 5 * 60_000;
    await drains(p, burst((i) => base + i * 500));
  });

  it.each(['gmail', 'outlook'] as const)('%s: 600 mails with one received time', async (p) => {
    await w.addMailbox(p, 'agent', 'agent.box@example.com', 'agent', 6 * 60_000);
    const at = Date.now() - 5 * 60_000;
    await drains(p, burst(() => at));
  });
});
