// The busy-ack log (a text arrived while the agent was mid-turn) names the sender by kind, never the address.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';

const logged: string[] = [];
vi.mock('../../logger.js', async (orig) => {
  const actual = await orig<typeof import('../../logger.js')>();
  const line = (message: string, fields?: unknown): void => { logged.push(`${message} ${JSON.stringify(fields ?? {})}`); };
  return { ...actual, createLogger: () => ({ debug: () => {}, info: line, warn: line, error: line }) };
});
vi.mock('../imessage-run.js', async (orig) => ({
  ...(await orig<typeof import('../imessage-run.js')>()),
  getImsgPath: () => null,
  runMessagesProgram: vi.fn(async () => ''),
}));
vi.mock('../../gateway/ws.js', async (orig) => ({ ...(await orig<typeof import('../../gateway/ws.js')>()), broadcast: vi.fn() }));
vi.mock('../../agent/runtime.js', async (orig) => ({
  ...(await orig<typeof import('../../agent/runtime.js')>()),
  getAgentRuntime: () => ({ handleMessage: vi.fn(async () => {}) }),
}));

import { runMigrations } from '../../db/migrations.js';
import { getDb } from '../../db/connection.js';
import { activeRuns, agentStartTimes } from '../../agent/shared-state.js';
import { maybeSendBusyAck } from '../imessage-bridge.js';

const OWNER = '+15550100198';
const FRIEND = '+15550100777';
const AGENT = randomUUID();
const busyAckLine = (): string => logged.filter((l) => l.startsWith('Busy-ack sent')).at(-1) ?? '';

beforeAll(() => {
  runMigrations();
  getDb().prepare("INSERT INTO agents (id, name, status, config, classification) VALUES (?, 'main', 'working', '{}', 'sensei')").run(AGENT);
  getDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('imessage_approved_senders', ?)").run(JSON.stringify([
    { address: OWNER, name: 'Owner', is_primary: true, sharing_level: 'full' },
    { address: FRIEND, name: 'Friend', is_primary: false, sharing_level: 'dont_overshare' },
  ]));
  activeRuns.add(AGENT);
  agentStartTimes.set(AGENT, Date.now() - 120_000);   // a turn running for two minutes
});

describe('the busy-ack log', () => {
  it('names the owner by kind and never writes his number', () => {
    maybeSendBusyAck(AGENT, OWNER);
    expect(busyAckLine()).toContain('the owner');
    expect(busyAckLine()).not.toContain(OWNER);
  });
  it('names another approved sender by kind and never writes the number', () => {
    maybeSendBusyAck(AGENT, FRIEND);
    expect(busyAckLine()).toContain('an approved sender');
    expect(busyAckLine()).not.toContain(FRIEND);
  });
});
