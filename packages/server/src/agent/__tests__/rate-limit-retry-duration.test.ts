// formatDuration turns a whole number of seconds into the wording the owner and
// the agent read: "You were rate-limited by the API for X", "has been
// rate-limited for X", "Still rate-limited after X".
//
// The boundary cases are the point of this test. A value just under a boundary
// must round up to the next whole unit and carry into it ("60m" is "1h"), not
// print a 60-minute remainder in the wrong column.

import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';

// Importing rate-limit-retry.js pulls in the database, websocket and messaging
// modules. formatDuration reads none of them, so these mocks only keep the
// import graph from touching the real connection at load time; the bodies are
// inert for a pure function.
vi.mock('../../db/connection.js', () => ({
  getDb: vi.fn(),
  closeDb: vi.fn(),
  getDbPath: () => path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-dur-test', 'dojo.db'),
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../services/imessage-bridge.js', () => ({ sendAlert: vi.fn() }));
vi.mock('../errors.js', () => ({ notifyRateLimitHit: vi.fn() }));
vi.mock('../../config/platform.js', () => ({ isPrimaryAgent: vi.fn() }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: vi.fn() }));
vi.mock('../agent-status.js', () => ({ setAgentStatus: vi.fn(), writeAgentStatus: vi.fn() }));

import { formatDuration } from '../rate-limit-retry.js';

// input seconds -> expected text
const cases: Array<[number, string]> = [
  [0, '0s'],
  [59, '59s'],
  [60, '1m'],
  [89, '1m'],
  [90, '2m'],
  [3569, '59m'],
  [3570, '1h'],
  [3599, '1h'],
  [3600, '1h'],
  [3629, '1h'],
  [3630, '1h 1m'],
  [7199, '2h'],
  [7200, '2h'],
  [7230, '2h 1m'],
  [86399, '24h'],
];

describe('formatDuration', () => {
  it.each(cases)('renders %i seconds as "%s"', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});
