// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 K33 fix round 1 (review I-K4) — A STORED AGENT REPORT READS BACK AS ITS SENDER WROTE IT.
//
// The fence is for the model only (orchestrator ruling). A worker's report to the main agent is
// stored fenced, because the stored row is what the model reads. Two readers of that row are not a
// model: the semantic dedup (which compared a fenced stored payload with a raw new one, so the
// fence's boilerplate weakened the ack-loop damping) and the crash-recovery relay (which handed the
// fence lines on toward the OWNER'S phone). Both now read the payload without the fence.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '../../db/migrations.js';
import { getDb } from '../../db/connection.js';
import { insertMessageIfAbsent } from '../../memory/message-store.js';
import { extractPayloadFromA2AMessage, findUnlandedInboundReply } from '../a2a-transport.js';
import { a2aPayloadForModel } from '../../tools/inbound-fences.js';

const REPORT = 'Done: the crate count is forty-two.\nAll receipts are filed.';
const THREAD = 'thread-k33-r1-0001';

beforeAll(() => {
  runMigrations();
  getDb().prepare("INSERT OR IGNORE INTO agents (id, name, status) VALUES ('primary', 'The main agent', 'idle'), ('worker-1', 'A worker', 'idle')").run();
});

describe('K33 fix round 1 — a stored agent report reads back as written', () => {
  const stored = `[A2A:DELIVERABLE thread:${THREAD.slice(0, 8)} from:A worker] ${a2aPayloadForModel('primary', 'worker-1', false, 'A worker', REPORT)}\n\n[Thread ${THREAD}]`;

  it('the stored row the model reads IS fenced (the premise)', () => {
    expect(stored).toContain('[EXTERNAL agent report from A worker');
  });

  it('dedup compares the sender\'s words, not the fence', () => {
    expect(extractPayloadFromA2AMessage(stored)).toBe(REPORT);
  });

  it('the crash-recovery relay hands on the sender\'s words, never the fence lines', () => {
    insertMessageIfAbsent({ id: 'm-k33-r1', agentId: 'primary', role: 'user', content: stored,
      sourceAgentId: 'worker-1', a2aThreadId: THREAD, a2aIntent: 'DELIVERABLE' });
    const found = findUnlandedInboundReply('primary', THREAD, Date.now());
    expect(found?.payload).toBe(REPORT);
  });
});
