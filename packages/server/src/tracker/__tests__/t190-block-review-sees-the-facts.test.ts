// ════════════════════════════════════════════════════════════════════════════════════════
// t190 C3 — THE PM'S BLOCK REVIEW ALWAYS SEES THE REAL RECENT TOOL AND CONNECTION FACTS.
//
// THE GAP (GitHub #16). A worker agent marked a task blocked citing a "broken" mail tool. The
// PM's review payload held the goal and the worker's own words and nothing else, so the PM
// confirmed every block in about two minutes without checking whether the tool had in fact
// been working. The platform HAS the facts (the per-tool outcome record, the connection
// state); the review simply never carried them.
//
// THE RULING (owner). ALWAYS shown, for the tools and connections the task involves. The
// engine gathers them; the PM is given no new tool and queries nothing.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* not exercised */ } }));
vi.mock('../../services/capability-registry.js', () => ({
  listIntegrationStatuses: () => [{ name: 'google', configured: true, connected: true }],
}));
vi.mock('../../agent/access/read.js', () => ({
  mayUsePlaud: () => false,
  widestIntegrationLevel: () => 'full',
}));
vi.mock('../../plaud/auth.js', () => ({
  getPlaudStatus: () => ({ connected: false, connectedAt: null }),
}));

import { runMigrations } from '../../db/migrations.js';
import { noteToolOutcome } from '../../agent/v2/tool-outcomes.js';
import { unvalidatedBlockIssueText } from '../block-review-facts.js';

const WORKER = 'agent-worker-1';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

const review = (blockReason: string, assigneeId: string | null = WORKER) =>
  unvalidatedBlockIssueText({
    taskId: 'task-0000000001', title: 'Sort the support mailbox', agentName: 'the worker',
    assigneeId, goal: 'Keep the support inbox clear', priority: 'normal', revertCount: 0, blockReason,
  });

describe('t190 C3 — the block review carries the platform\'s own facts', () => {
  it('a block citing a "broken" tool that has SINCE SUCCEEDED shows that, with both instants', async () => {
    noteToolOutcome(WORKER, 'gmail_label', true, 'Error modifying labels: Invalid label: Junk');
    noteToolOutcome(WORKER, 'gmail_label', false);
    const text = await review('gmail_label is broken and I cannot archive anything');
    expect(text).toContain('UNVALIDATED_BLOCK:');
    expect(text).toMatch(/gmail_label[^\n]*last SUCCEEDED \[[^\]]+\]/);
    expect(text).toMatch(/gmail_label[^\n]*last FAILED \[[^\]]+\]/);
    expect(text).toMatch(/gmail_label[^\n]*most recent call SUCCEEDED/);
    expect(text).toContain('Invalid label: Junk');
  });

  it('an open failure is shown as the most recent call FAILED, with its error text and streak', async () => {
    noteToolOutcome(WORKER, 'gmail_search', true, 'quota exceeded');
    noteToolOutcome(WORKER, 'gmail_search', true, 'quota exceeded');
    const text = await review('the mail search keeps failing');
    expect(text).toMatch(/gmail_search[^\n]*most recent call FAILED[^\n]*2 in a row/);
    expect(text).toContain('quota exceeded');
  });

  it('a tool with an open failure is shown even when the block text never names it', async () => {
    noteToolOutcome(WORKER, 'gmail_send', true, 'daily limit');
    const text = await review('I cannot finish this');
    expect(text).toMatch(/gmail_send[^\n]*most recent call FAILED/);
  });

  it('the connections the agent may use are always shown', async () => {
    const text = await review('waiting on the owner');
    expect(text).toMatch(/Google Workspace — CONNECTED/);
  });

  it('with nothing recorded the facts section is STILL there, and says so', async () => {
    const text = await review('waiting on the owner');
    expect(text).toMatch(/PLATFORM FACTS/);
    expect(text).toMatch(/no recorded outcome/i);
  });

  it('the PM is told how to use them: a contradiction means not really blocked', async () => {
    const text = await review('gmail_label is broken');
    expect(text).toMatch(/contradict/i);
    expect(text).toContain('work_validate(action="validate", kind="blocked", task_id="task-0000000001", valid=true)');
    expect(text).toContain('valid=false, reject_reason=');
  });

  it('an unassigned task still gets the section', async () => {
    const text = await review('no one owns this', null);
    expect(text).toMatch(/PLATFORM FACTS/);
  });
});
