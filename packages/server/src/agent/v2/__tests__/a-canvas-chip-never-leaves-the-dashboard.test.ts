// A document the agent opened in the canvas, and the live screen chip, are dashboard affordances: they never ride a
// reply to a person's text channel, whether the turn ends with words or with no reply.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => (await import('./helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { queueCanvasDoc, queueScreenChip } from '../../pending-attachments.js';
import { deliverDueReplies } from '../channel-sender.js';
import { freshReplyDb, imessage, AGENT } from './helpers/reply-sender.js';
import { imessageTurn } from './helpers/imessage-turn.js';

beforeEach(() => freshReplyDb(runMigrations));

describe('a canvas chip never leaves the dashboard', () => {
  it('a reply with a canvas document and the screen chip texts the words only', async () => {
    const turn = imessageTurn();
    queueCanvasDoc(AGENT, { fileId: 'c1', filename: 'plan.md', mimeType: 'text/markdown', size: 10, path: '/tmp/dojo-test-canvas/plan.md', category: 'text', openInCanvas: true });
    queueScreenChip(AGENT);
    await turn.say('I opened the plan for you.');
    await turn.finalize();
    await deliverDueReplies(Date.now());
    expect(imessage.sent).toEqual(['I opened the plan for you.']);
  });
});
