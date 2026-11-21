// A picture asked for on the dashboard is posted there and queued for no phone, even while the owner is away.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const notice = vi.hoisted(() => vi.fn((_opts: { brief: string }) => null));
vi.mock('../../../../db/connection.js', async () => (await import('../../../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../../../services/imessage-bridge.js', async (orig) => (await import('../../../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../agent-notice.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), postAgentNotice: notice }));
vi.mock('../../../../costs/tracker.js', () => ({ recordCost: vi.fn() }));
vi.mock('../../../../costs/spend.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), exceededBudget: () => null }));
vi.mock('../../../../services/image-gen-model.js', () => ({ getEffectiveImageGenModel: () => ({ modelId: 'm', providerId: 'p' }) }));
vi.mock('../../../../services/image-generation.js', () => ({ generateImage: vi.fn() }));

import { runMigrations } from '../../../../db/migrations.js';
import { mediaHandlers } from '../media.js';
import { setPresence } from '../../../../services/presence.js';
import { generateImage } from '../../../../services/image-generation.js';
import { freshReplyDb, imessage, replyRows, AGENT } from '../../../v2/__tests__/helpers/reply-sender.js';

const picture = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-test-picture-')), 'kite.png');
fs.writeFileSync(picture, 'png');

beforeEach(() => {
  freshReplyDb(runMigrations);
  setPresence('away');
  notice.mockClear();
  vi.mocked(generateImage).mockResolvedValue({ ok: true, filePath: picture, filename: 'kite.png', mimeType: 'image/png', sizeBytes: 3, latencyMs: 1, providerId: 'p', width: 1, height: 1, inputTokens: 0, outputTokens: 0 } as never);
});

const makePicture = () => mediaHandlers.image_create({ agentId: AGENT, name: 'image_create', args: { description: 'a red kite', title: 'Red Kite' }, callId: 'c', toolCall: {} as never });

describe('a picture asked on the dashboard is not texted while away', () => {
  it('away, asked on the dashboard: posted, and nothing is queued for a phone', async () => {
    await makePicture();
    await vi.waitFor(() => expect(notice).toHaveBeenCalled());
    expect(replyRows()).toEqual([]);
    expect(imessage.sendFile).not.toHaveBeenCalled();
    expect(notice.mock.calls[0][0].brief).toContain('your picture was posted in the dashboard, with no caption');
  });
});
