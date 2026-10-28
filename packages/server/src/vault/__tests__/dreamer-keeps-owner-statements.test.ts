// preprocessMessages trims an archived conversation before the Dreamer ever
// reads it. Its process-narration patterns ("Let me…", "I'll…", "I found…")
// exist to drop the scaffolding the agent emits between tool calls; applied
// to user messages the same patterns silently discard the owner's own plans
// and facts — exactly what the vault exists to keep. These clauses pin the
// split: narration is dropped for the assistant, kept for the user.

import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  // The vault's reads route through the reader pool, which asks the connection module WHERE
  // the database is. These clauses never reach a read, so the pool declines itself and
  // every read would run on this connection — the honest answer.
  getDbPath: () => ':memory:',
}));

// Fixed identities so maintenance resolves a primary + Dreamer without the real
// config lookups (which would need the platform config seeded).
vi.mock('../../config/platform.js', () => ({
  getPrimaryAgentId: () => 'primary',
  getDreamerAgentId: () => 'dreamer',
  getDreamerAgentName: () => 'Dreamer',
  isSetupCompleted: () => true,
}));

// Heavy collaborators pulled in at module load; stubbed so importing maintenance
// stays hermetic. None are exercised by the pure filter under test.
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../agent/spawner.js', () => ({ spawnAgent: vi.fn() }));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock('../../agent/v2/counterparty.js', () => ({ rehomeUnclaimedEngineEvents: vi.fn() }));

// The store is the archive/report boundary. The filter never touches it; the
// mock keeps the maintenance import hermetic.
const store = vi.hoisted(() => ({
  getUnprocessedConversations: vi.fn(),
  getUnprocessedConversationMeta: vi.fn(),
  getUnprocessedConversationById: vi.fn(),
  getUnprocessedConversationCount: vi.fn(),
  getVaultStats: vi.fn(() => ({ totalEntries: 0, pinnedCount: 0, permanentCount: 0 })),
  createDreamReport: vi.fn(),
  getConversation: vi.fn(() => null),
  incrementArchiveAttempt: vi.fn(() => 1),
  markArchivePoisoned: vi.fn(),
  markConversationProcessed: vi.fn(),
}));
vi.mock('../store.js', () => store);

import { preprocessMessages } from '../maintenance.js';

function keptContents(messages: Array<{ role: string; content: string }>): string[] {
  return preprocessMessages(messages).map(m => m.content);
}

describe('preprocessMessages keeps the owner\'s own statements', () => {
  it('keeps a user plan opening with "I\'m going to"', () => {
    const content = 'I\'m going to move to Denver in March next year.';
    expect(keptContents([{ role: 'user', content }])).toEqual([content]);
  });

  it('keeps a user plan opening with "I\'ll"', () => {
    const content = 'I\'ll be traveling the first two weeks of June.';
    expect(keptContents([{ role: 'user', content }])).toEqual([content]);
  });

  it('keeps a user fact opening with "First,"', () => {
    const content = 'First, my wife\'s name is Dana and she likes tea.';
    expect(keptContents([{ role: 'user', content }])).toEqual([content]);
  });

  it('keeps a user discovery opening with "I found"', () => {
    const content = 'I found out my dog has diabetes last week, vet says insulin.';
    expect(keptContents([{ role: 'user', content }])).toEqual([content]);
  });

  it('keeps a user correction opening with "I see"', () => {
    const content = 'I see you have my old address; mine is 12 Oak Street now.';
    expect(keptContents([{ role: 'user', content }])).toEqual([content]);
  });

  it('drops assistant narration opening with "Let me"', () => {
    expect(keptContents([{ role: 'assistant', content: 'Let me check the calendar for you now, one moment please.' }])).toEqual([]);
  });

  it('drops assistant narration opening with "I found"', () => {
    expect(keptContents([{ role: 'assistant', content: 'I found three matching files in the downloads folder.' }])).toEqual([]);
  });

  it('still drops a short ack and keeps long user prose that opens with "Let me"', () => {
    const long = 'Let me tell you about the raised beds: they go in next month, and I want the irrigation lines buried before the first frost arrives in late November.';
    expect(keptContents([
      { role: 'user', content: 'ok' },
      { role: 'user', content: long },
    ])).toEqual([long]);
  });
});
