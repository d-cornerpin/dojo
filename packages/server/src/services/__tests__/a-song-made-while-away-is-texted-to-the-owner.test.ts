// A finished song or spoken clip goes to a phone like a picture: to the owner when he is away, to the person who
// asked by iMessage, and to nobody while the owner is at the Dojo and asked on the dashboard.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const presence = vi.hoisted(() => ({ now: 'away' }));
const notice = vi.hoisted(() => vi.fn((_opts: { brief: string }) => null));
vi.mock('../../db/connection.js', async () => (await import('../../agent/v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../imessage-bridge.js', async (orig) => (await import('../../agent/v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../presence.js', () => ({ getPresence: () => presence.now, isImessageConfigured: () => true }));
vi.mock('../../agent/access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/agent-notice.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), postAgentNotice: notice }));
vi.mock('../../costs/tracker.js', () => ({ recordCost: vi.fn() }));
vi.mock('../audio-generation.js', () => ({ generateAudio: vi.fn() }));

import { runMigrations } from '../../db/migrations.js';
import { insertMessageIfAbsent } from '../../memory/message-store.js';
import { createGenerationJob, enqueueAudioOrMusicJob } from '../generation-jobs.js';
import { generateAudio } from '../audio-generation.js';
import { deliverDueReplies } from '../../agent/v2/channel-sender.js';
import { freshReplyDb, imessage, replyRows, testDb, AGENT, OWNER, PERSON } from '../../agent/v2/__tests__/helpers/reply-sender.js';

const clip = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-test-song-')), 'clip.wav');
fs.writeFileSync(clip, 'a short song');

beforeEach(() => {
  freshReplyDb(runMigrations);
  presence.now = 'away';
  notice.mockClear();
  vi.mocked(generateAudio).mockResolvedValue({ ok: true, filePath: clip, mimeType: 'audio/wav', sizeBytes: 12, durationSeconds: 2, providerId: 'p', inputTokens: 0, outputTokens: 0, latencyMs: 1 } as never);
});

/** Runs one music job to its delivery; `asked` is the request message the job serves. */
async function makeSong(asked: string | null = null): Promise<void> {
  const id = createGenerationJob({ kind: 'music', agentId: AGENT, modelId: 'm', providerId: 'p', prompt: 'a short song' });
  testDb().prepare('UPDATE generation_jobs SET source_message_id = ? WHERE id = ?').run(asked, id);
  await enqueueAudioOrMusicJob(id);
  await deliverDueReplies(Date.now());
}

describe('a song made while away is texted to the owner', () => {
  it('away: the song asked for on the dashboard goes to the owner as the file', async () => {
    await makeSong();
    expect(imessage.sendFile).toHaveBeenCalledWith(OWNER, expect.stringContaining(path.join('.dojo', 'uploads', AGENT, 'music-')));
    expect(imessage.send).not.toHaveBeenCalled();
    expect(notice.mock.calls[0][0].brief).toContain('posted in the dashboard and is being texted to the owner by iMessage');
  });

  it('at the Dojo: nothing is texted and the agent is told it is in the dashboard', async () => {
    presence.now = 'in_dojo';
    await makeSong();
    expect(replyRows()).toEqual([]);
    expect(notice.mock.calls[0][0].brief).toContain('your music was posted in the dashboard, with no caption');
  });

  it('asked by iMessage: the song goes back to the person who asked', async () => {
    presence.now = 'in_dojo';
    insertMessageIfAbsent({ id: 'msg-1', agentId: AGENT, role: 'user', content: 'sing me something', inboundMeta: JSON.stringify({ channel: 'imessage', sender: PERSON }) });
    await makeSong('msg-1');
    expect(imessage.sendFile).toHaveBeenCalledWith(PERSON, expect.stringContaining('music-'));
    expect(replyRows()).toMatchObject([{ outcome: 'delivered' }]);
  });
});
