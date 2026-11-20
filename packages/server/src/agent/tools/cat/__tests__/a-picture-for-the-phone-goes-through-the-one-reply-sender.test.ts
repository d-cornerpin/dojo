// A finished picture owed to a phone is queued as a reply with the file and sent by the one reply sender, like a song
// or a video; image_create never texts it itself.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const presence = vi.hoisted(() => ({ now: 'away' }));
const notice = vi.hoisted(() => vi.fn((_opts: { brief: string }) => null));
vi.mock('../../../../db/connection.js', async () => (await import('../../../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../../../services/imessage-bridge.js', async (orig) => (await import('../../../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../../../../services/presence.js', () => ({ getPresence: () => presence.now, isImessageConfigured: () => true }));
vi.mock('../../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../agent-notice.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), postAgentNotice: notice }));
vi.mock('../../../../costs/tracker.js', () => ({ recordCost: vi.fn() }));
vi.mock('../../../../costs/spend.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), exceededBudget: () => null }));
vi.mock('../../../../services/image-gen-model.js', () => ({ getEffectiveImageGenModel: () => ({ modelId: 'm', providerId: 'p' }) }));
vi.mock('../../../../services/image-generation.js', () => ({ generateImage: vi.fn() }));

import { runMigrations } from '../../../../db/migrations.js';
import { mediaHandlers } from '../media.js';
import { generateImage } from '../../../../services/image-generation.js';
import { deliverDueReplies } from '../../../v2/channel-sender.js';
import { freshReplyDb, imessage, replyRows, AGENT, OWNER } from '../../../v2/__tests__/helpers/reply-sender.js';

const picture = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-test-picture-')), 'kite.png');
fs.writeFileSync(picture, 'png');

beforeEach(() => {
  freshReplyDb(runMigrations);
  presence.now = 'away';
  notice.mockClear();
  vi.mocked(generateImage).mockResolvedValue({ ok: true, filePath: picture, filename: 'kite.png', mimeType: 'image/png', sizeBytes: 3, latencyMs: 1, providerId: 'p', width: 1, height: 1, inputTokens: 0, outputTokens: 0 } as never);
});

const makePicture = () => mediaHandlers.image_create({ agentId: AGENT, name: 'image_create', args: { description: 'a red kite', title: 'Red Kite' }, callId: 'c', toolCall: {} as never });

describe('a picture for the phone goes through the one reply sender', () => {
  it('away: the sender texts the picture to the owner from one reply row', async () => {
    await makePicture();
    await vi.waitFor(() => expect(notice).toHaveBeenCalled());
    await deliverDueReplies(Date.now());
    expect(imessage.sendFile).toHaveBeenCalledWith(OWNER, expect.stringContaining(path.join('.dojo', 'uploads', AGENT, 'red-kite-')));
    expect(replyRows()).toMatchObject([{ outcome: 'delivered' }]);
    expect(notice.mock.calls[0][0].brief).toContain('your picture was posted in the dashboard and is being texted to the owner by iMessage');
  });

  it('at the Dojo, asked on the dashboard: nothing is queued for a phone', async () => {
    presence.now = 'in_dojo';
    await makePicture();
    await vi.waitFor(() => expect(notice).toHaveBeenCalled());
    expect(replyRows()).toEqual([]);
    expect(imessage.sendFile).not.toHaveBeenCalled();
  });
});
