// standing_promise, asserts_board_state and a memory note's obligation shape: the decision model answers below 0.3 and
// at 0.7 or above; between, its word list decides. The endpoint answers scripted probabilities.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import '../decision-ask.js';
import { __forgetResidencyForTests } from '../decide.js';
import { askReplyClaims, replyClaim, type ReplyClaim } from '../v2/reply-claims.js';
import { isObligationNote } from '../../work/obligation-memory.js';
import { installDecisionModel, scriptDecisions, yes } from './decision-fake.js';

let n = 0;
beforeEach(() => { mockDb.current = new Database(':memory:'); runMigrations(mockDb.current); __forgetResidencyForTests(); installDecisionModel(mockDb.current); });
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

async function claim(name: ReplyClaim, reply: string): Promise<boolean | undefined> {
  const at = { agentId: `a-${++n}`, messageId: `m-${n}` };
  await askReplyClaims({ toolResults: [] } as never, { ...at, db: { prepare: () => ({ get: () => undefined }) }, turnNumber: 1, result: { toolCalls: [] }, lastUserMessageContent: 'ok?' } as never, reply);
  return replyClaim(at, name);
}

const CASES: Array<{ name: string; listYes: string; listNo: string; ask: (text: string) => Promise<boolean | undefined> }> = [
  { name: 'standing_promise', listYes: 'From now on I will text you first.', listNo: 'I texted you the address.', ask: (t) => claim('standing_promise', t) },
  { name: 'asserts_board_state', listYes: 'Your dentist reminder is still scheduled.', listNo: 'The shop closes at six.', ask: (t) => claim('asserts_board_state', t) },
  { name: 'obligation', listYes: 'I need to send the invoice to the landlord.', listNo: 'The bike lock code is 3019.', ask: (t) => isObligationNote('a-1', t) },
];

describe('inside the unsure band the word list decides', () => {
  for (const { name, listYes, listNo, ask } of CASES) {
    it(`${name}: at 0.5 the list answers, both ways`, async () => {
      scriptDecisions(() => yes(0.5));
      expect(await ask(listYes)).toBe(true);
      expect(await ask(listNo)).toBe(false);
    });
    it(`${name}: outside the band the model answers, whatever the list says`, async () => {
      scriptDecisions(() => yes(0.2));
      expect(await ask(listYes)).toBe(false);
      scriptDecisions(() => yes(0.8));
      expect(await ask(listNo)).toBe(true);
    });
  }
});
