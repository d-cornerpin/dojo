// The PM effort-review prompt lists the assignee's recent messages. Each line used to start with
// the raw epoch-millisecond number of messages.created_at; it must read as a date and time in
// the owner's (box) timezone.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => { /* no-op */ } }) }));
vi.mock('../../agent/agent-bus.js', () => ({ sendAgentMessage: () => { /* no-op */ } }));
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: () => 'notice-id' }));

import { recentAssigneeActivityLines } from '../pm-agent.js';

describe('recentAssigneeActivityLines shows readable times', () => {
  beforeEach(() => {
    mockDb.current = new Database(':memory:');
    mockDb.current.exec(`CREATE TABLE messages (seq INTEGER PRIMARY KEY, id TEXT, agent_id TEXT, role TEXT, content TEXT, created_at INTEGER)`);
  });

  it('renders the epoch-ms time as a date and time in the box zone, not a 13-digit number', () => {
    const ms = Date.UTC(2026, 6, 10, 12, 30, 0);
    mockDb.current!.prepare(`INSERT INTO messages (id, agent_id, role, content, created_at) VALUES ('m1','a1','assistant','hello',?)`).run(ms);
    const out = recentAssigneeActivityLines('a1');
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ms)).reduce<Record<string, string>>((a, p) => { a[p.type] = p.value; return a; }, {});
    const expected = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
    expect(out).toContain(`[${expected}] [assistant]`);
    expect(out).not.toMatch(/\[\d{13}\]/);
  });
});
