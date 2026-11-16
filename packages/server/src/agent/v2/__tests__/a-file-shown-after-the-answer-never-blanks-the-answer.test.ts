// A file shown after the reply was written (no words after it) joins that reply: the answer the turn records stays
// the reply, and the person gets the words and then the file, never an empty line in place of the answer.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => (await import('./helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { queuePendingAttachments } from '../../pending-attachments.js';
import { deliverDueReplies } from '../channel-sender.js';
import { freshReplyDb, imessage, testDb, AGENT } from './helpers/reply-sender.js';
import { imessageTurn } from './helpers/imessage-turn.js';

const chart = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-test-files-')), 'chart.png');
fs.writeFileSync(chart, 'a chart');

beforeEach(() => freshReplyDb(runMigrations));

describe('a file shown after the answer never blanks the answer', () => {
  it('keeps the reply as the answer and sends the file after its words', async () => {
    const turn = imessageTurn();
    await turn.say('Sales rose 8% this quarter.');
    const replyKey = turn.answerKey();
    queuePendingAttachments(AGENT, [{ fileId: 'f1', filename: 'chart.png', mimeType: 'image/png', size: 7, path: chart, category: 'image' }], 'The chart.');
    await turn.finalize();
    const answer = testDb().prepare('SELECT content FROM messages WHERE id = ?').get(turn.answerKey()) as { content: string };
    expect(turn.answerKey()).toBe(replyKey);
    expect(answer.content).toBe('Sales rose 8% this quarter.');
    await deliverDueReplies(Date.now());
    expect(imessage.sent).toEqual(['Sales rose 8% this quarter.\n\nThe chart.', `file ${chart}`]);
  });
});
