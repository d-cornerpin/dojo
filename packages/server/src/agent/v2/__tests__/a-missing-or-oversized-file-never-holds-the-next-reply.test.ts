// A file that is gone, or too big for iMessage, is taken off its reply before any send: the words go, the row is
// delivered and names the file, the agent is told, and the next reply to the same person goes right behind it.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const told = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => (await import('./helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../wake-with-notice.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), tellAgentAndWake: told }));

import { runMigrations } from '../../../db/migrations.js';
import { queuePendingAttachments } from '../../pending-attachments.js';
import { deliverDueReplies } from '../channel-sender.js';
import { freshReplyDb, imessage, replyRows, AGENT } from './helpers/reply-sender.js';
import { imessageTurn } from './helpers/imessage-turn.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-test-files-'));
const gone = path.join(dir, 'gone.pdf');
const huge = path.join(dir, 'huge.mov');
fs.writeFileSync(huge, '');
fs.truncateSync(huge, 101 * 1024 * 1024);   // sparse: no disk is written

beforeEach(() => { freshReplyDb(runMigrations); told.mockClear(); });

const file = (p: string) => ({ fileId: p, filename: path.basename(p), mimeType: 'application/octet-stream', size: 0, path: p, category: 'unknown' as const });

describe('a missing or oversized file never holds the next reply', () => {
  it('sends the words alone, names the files, and lets the next reply go', async () => {
    const first = imessageTurn(1);
    queuePendingAttachments(AGENT, [file(gone), file(huge)]);
    await first.say('Here are the two files.');
    await first.finalize();
    const second = imessageTurn(2);
    await second.say('And the summary: all on track.');
    await second.finalize();
    await deliverDueReplies(Date.now());
    expect(imessage.sendFile).not.toHaveBeenCalled();
    expect(imessage.sent).toEqual(['Here are the two files.', 'And the summary: all on track.']);
    const [row1, row2] = replyRows();
    expect(row1.outcome).toBe('delivered');
    expect(row1.detail).toContain('gone.pdf');
    expect(row1.detail).toContain('huge.mov');
    expect(row2.outcome).toBe('delivered');
    expect(told).toHaveBeenCalledTimes(1);
    expect((told.mock.calls[0] as unknown as [{ brief: string }])[0].brief).toMatch(/gone\.pdf.*huge\.mov/);
  });
});
