// A finished video asked for by iMessage reaches the asker's phone as a link to the video, never as the file.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const notice = vi.hoisted(() => vi.fn((_opts: { brief: string }) => null));
vi.mock('../../db/connection.js', async () => (await import('../../agent/v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../imessage-bridge.js', async (orig) => (await import('../../agent/v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../../agent/access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/agent-notice.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), postAgentNotice: notice }));
vi.mock('../../config/loader.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getProviderCredential: () => 'test-key' }));

import { runMigrations } from '../../db/migrations.js';
import { enqueueVideoJob } from '../video-job-poller.js';
import { deliverDueReplies } from '../../agent/v2/channel-sender.js';
import { insertMessageIfAbsent } from '../../memory/message-store.js';
import { freshReplyDb, imessage, testDb, AGENT, PERSON } from '../../agent/v2/__tests__/helpers/reply-sender.js';

const realFetch = globalThis.fetch;

beforeEach(() => {
  freshReplyDb(runMigrations);
  const db = testDb();
  db.prepare("INSERT INTO providers (id, name, type, base_url, auth_type) VALUES ('prov', 'Test', 'openai-compatible', 'https://example.test/api', 'api_key')").run();
  db.prepare("INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled) VALUES ('model', 'prov', 'Video', 'api/video', '[\"video_generation\"]', 1)").run();
  insertMessageIfAbsent({ id: 'msg-1', agentId: AGENT, role: 'user', content: 'make me a beach video', inboundMeta: JSON.stringify({ channel: 'imessage', sender: PERSON }) });
  db.prepare("INSERT INTO video_jobs (id, agent_id, model_id, provider_id, provider_job_id, prompt, title, status, attempt_count, source_message_id) VALUES ('vid_beach123', ?, 'model', 'prov', 'job-1', 'a beach', 'Beach Day', 'queued', 0, 'msg-1')").run(AGENT);
  globalThis.fetch = vi.fn(async (input: unknown) => String(input).endsWith('/content')
    ? new Response(Buffer.from('fake-mp4-bytes'), { status: 200 })
    : new Response(JSON.stringify({ status: 'completed', duration_seconds: 4 }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof globalThis.fetch;
});

afterEach(() => { globalThis.fetch = realFetch; });

describe('a video arrives as a link', () => {
  it('asked by iMessage: the asker is texted a link to the video and no file', async () => {
    await enqueueVideoJob('vid_beach123');
    await deliverDueReplies(Date.now());
    expect(imessage.send).toHaveBeenCalledWith(PERSON, expect.stringMatching(/^Download: http:\/\/localhost:\d+\/share\/[^/]+\/beach-day-beach123\.mp4$/));
    expect(imessage.sendFile).not.toHaveBeenCalled();
    expect(notice.mock.calls[0][0].brief).toContain('your video was posted in the dashboard and is being texted to the person who asked by iMessage as a link');
  });
});
