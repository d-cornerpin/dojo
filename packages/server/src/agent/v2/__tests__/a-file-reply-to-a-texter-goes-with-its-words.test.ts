// A file the agent shows a person who texted rides the reply's own row: the words go first, then the file, through
// the one sender, and the row is delivered once both went.
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
import { freshReplyDb, imessage, replyRows, AGENT, PERSON } from './helpers/reply-sender.js';
import { imessageTurn } from './helpers/imessage-turn.js';

const plan = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-test-files-')), 'plan.pdf');
fs.writeFileSync(plan, 'a floor plan');

beforeEach(() => freshReplyDb(runMigrations));

describe('a file reply to a texter goes with its words', () => {
  it('sends the words, then the file, from one delivered reply row', async () => {
    const turn = imessageTurn();
    queuePendingAttachments(AGENT, [{ fileId: 'f1', filename: 'plan.pdf', mimeType: 'application/pdf', size: 12, path: plan, category: 'pdf' }]);
    await turn.say('Here is the floor plan.'); 
    await turn.finalize();
    expect(imessage.sent).toEqual([]);
    await deliverDueReplies(Date.now());
    expect(imessage.sent).toEqual(['Here is the floor plan.', `file ${plan}`]);
    expect(imessage.sendFile).toHaveBeenCalledWith(PERSON, plan);
    expect(replyRows()).toMatchObject([{ outcome: 'delivered', attempts: 1 }]);
  });
});
