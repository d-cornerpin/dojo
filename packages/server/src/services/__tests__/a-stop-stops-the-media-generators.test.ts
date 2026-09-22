// ════════════════════════════════════════════════════════════════════════════════════════
// A-5 — THE STOP BUTTON STOPS THE MEDIA GENERATORS TOO.
//
// T83 established "every provider call an agent makes is abortable by that agent's stop" and
// the engine-tickets review recorded, as MINOR A-5, that it was not true of four files:
// `image-generation.ts`, `audio-generation.ts`, `video-generation.ts` and `transcription.ts`
// each called `fetch` directly, registered in nothing and carrying no signal but their own flat
// clock. The owner promoted it: the button stops ALL of an agent's activity.
//
// THE THREE THINGS EACH CLAUSE BELOW HAS TO PROVE, because a receipt for one of them is what
// A-1 wore while the defect survived on the fourth transport:
//
//   1. THE HTTP CALL IS CUT. Not "the promise was abandoned" — the signal handed to `fetch`
//      is aborted, which is the only thing that stops bytes moving and money being spent.
//      Every clause reads the signal the stub actually received.
//
//   2. THE IDENTITY IS HONEST. A stop is not a provider failure, and in this family that was
//      not a theoretical risk: `image-generation.ts`'s `isTimeoutError` classifies a bare
//      `AbortError` as its 10-minute deadline, so before this change a stop was reported to
//      the user as *"Image generation timed out after 10 minutes. The provider or model is
//      slow or overloaded right now. Try again in a moment…"* — the user's own button wearing
//      a provider's failure, with a retry suggestion attached. Clause §2 pins the words.
//
//   3. THE AGENT LANDS IN THE STOP PATH, NOT THE FAILURE PATH. The job row reaches
//      `cancelled`, carries no `error`, and posts no "I wasn't able to finish that…" bubble.
//
// AND THE POLLER (§5), which is the one that cannot be done with a per-call registration
// alone: the video loop runs for up to thirty minutes, outlives the run that started it, and
// is ASLEEP for nearly all of it. §5 measures that a stop lands while it is in its backoff
// sleep and gets it out in milliseconds, not at the next tick five seconds later.
//
// No real provider is contacted: `globalThis.fetch` is stubbed in every clause.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-a5-media-stop', 'dojo.db'),
  };
});

const frames: Array<Record<string, unknown>> = [];
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (e: Record<string, unknown>) => { frames.push(e); },
}));

vi.mock('../../config/loader.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getProviderCredential: () => 'test-key',
}));

// The effects facade refuses filesystem work outside an authorized tool call, and these
// generators each ensure their output directory on the way in. Nothing here is about the
// filesystem, so the facade is answered rather than driven.
vi.mock('../../agent/effects/fs.js', () => ({
  existsSync: () => true,
  mkdirSync: () => undefined,
  writeFileSync: () => undefined,
  copyFileSync: () => undefined,
  readFileSync: () => Buffer.alloc(0),
  statSync: () => ({ size: 0 }),
}));

// The turn machinery is irrelevant to the stop door; mocked so importing `runtime.js` for the
// one clause that drives the REAL button never pulls the model-call chain.
vi.mock('../../agent/v2/loop.js', () => ({ runV2Turn: vi.fn(async () => undefined) }));

import { runMigrations } from '../../db/migrations.js';

const AGENT = 'a5-media-agent';
const MODEL = 'model-media';
const PROVIDER = 'prov-media';

// ── the fetch stub ──────────────────────────────────────────────────────────────────────

interface Dial { url: string; signal: AbortSignal | undefined }
let dials: Dial[] = [];
const realFetch = globalThis.fetch;

/** Every request hangs until its signal aborts, then rejects the way undici does. */
function hangUntilAborted(): void {
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    dials.push({ url: String(input), signal });
    return new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException('This operation was aborted', 'AbortError')); return; }
      signal?.addEventListener(
        'abort',
        () => reject(new DOMException('This operation was aborted', 'AbortError')),
        { once: true },
      );
    });
  }) as unknown as typeof globalThis.fetch;
}

/** Answers with whatever the handler returns; records the signal it was handed. */
function answerWith(handler: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    dials.push({ url: String(input), signal: init?.signal ?? undefined });
    return handler(String(input));
  }) as unknown as typeof globalThis.fetch;
}

const tick = (ms = 10) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait until at least `n` dials have been recorded (or give up), so a stop lands mid-call. */
async function untilDialled(n = 1): Promise<void> {
  for (let i = 0; i < 100 && dials.length < n; i += 1) await tick(5);
}

async function stopNow(): Promise<number> {
  const { abortInFlight } = await import('../../agent/shared-state.js');
  return abortInFlight(AGENT, 'user-stop');
}

function seed(): void {
  const db = mockDb.current!;
  db.prepare(
    `INSERT INTO providers (id, name, type, base_url, auth_type) VALUES (?, 'Test', 'openai-compatible', 'https://example.test/api', 'api_key')`,
  ).run(PROVIDER);
  db.prepare(
    `INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled, pricing_unit, cost_per_unit)
     VALUES (?, ?, 'Media', 'api/media', '["image_generation","audio_generation","video_generation","transcription"]', 1, 'token', 0)`,
  ).run(MODEL, PROVIDER);
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Kevin', 'idle', '1970-01-01')`,
  ).run(AGENT);
}

beforeEach(() => {
  vi.resetModules();
  dials = [];
  frames.length = 0;
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  seed();
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  const s = await import('../../agent/shared-state.js');
  s.stoppedAgents.clear();
  s.activeRuns.clear();
  s.activeAbortControllers.clear();
  s.stopFencedRuns.clear();
  mockDb.current?.close();
  mockDb.current = null;
});

// ── §1 — the image dial ──────────────────────────────────────────────────────────────────

describe('§1 a stop cuts an image generation that is on the wire', () => {
  it('THE RED: the HTTP call is aborted and the result is the stop, not a provider failure', async () => {
    hangUntilAborted();
    const { generateImage } = await import('../image-generation.js');

    const inFlight = generateImage({ agentId: AGENT, modelId: MODEL, prompt: 'a cat' });
    await untilDialled();
    expect(dials.length, 'the generator reached the provider').toBe(1);

    const cut = await stopNow();
    const result = await inFlight;

    expect(cut, 'the stop found the media call in the registry').toBe(1);
    expect(dials[0].signal?.aborted, 'the fetch the provider is serving is cut').toBe(true);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('STOPPED');
  });

  it('THE MISREPORT, pinned by its own words: a stop never reads as the 10-minute deadline', async () => {
    // `isTimeoutError` answers true for a bare `AbortError`, so deleting the stop check that
    // runs BEFORE it puts the user's own button behind "the provider or model is slow or
    // overloaded right now. Try again in a moment" — advice to retry work he cancelled.
    hangUntilAborted();
    const { generateImage } = await import('../image-generation.js');
    const inFlight = generateImage({ agentId: AGENT, modelId: MODEL, prompt: 'a cat' });
    await untilDialled();
    await stopNow();
    const result = await inFlight;

    expect(result.ok === false && result.code).toBe('STOPPED');
    expect(result.ok === false && result.error).not.toMatch(/timed out/i);
    expect(result.ok === false && result.error).not.toMatch(/overloaded/i);
    expect(result.ok === false && result.error).toMatch(/stop/i);
  });

  it('a stop that landed FIRST is refused at the door — nothing is dialled at all', async () => {
    hangUntilAborted();
    const { stoppedAgents } = await import('../../agent/shared-state.js');
    const { generateImage } = await import('../image-generation.js');
    stoppedAgents.add(AGENT);

    const result = await generateImage({ agentId: AGENT, modelId: MODEL, prompt: 'a cat' });

    expect(dials, 'a call racing a live stop must not reach the provider').toEqual([]);
    expect(result.ok === false && result.code).toBe('STOPPED');
  });

  it('CONTROL: a genuine provider failure is still reported as a failure', async () => {
    answerWith(() => new Response('upstream exploded', { status: 500 }));
    const { generateImage } = await import('../image-generation.js');
    const result = await generateImage({ agentId: AGENT, modelId: MODEL, prompt: 'a cat' });
    expect(result.ok === false && result.code).toBe('HTTP_ERROR');
    expect(result.ok === false && result.error).toMatch(/HTTP 500/);
  });

  it('CONTROL: a genuine deadline is still reported as the deadline, not as a stop', async () => {
    // The other half of the discrimination. No stop is live; the clock fires.
    globalThis.fetch = vi.fn(async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }) as unknown as typeof globalThis.fetch;
    const { generateImage } = await import('../image-generation.js');
    const result = await generateImage({ agentId: AGENT, modelId: MODEL, prompt: 'a cat' });
    expect(result.ok === false && result.code).toBe('TIMEOUT');
  });

  it('CONTROL: the registration is released, so a settled call is not the next stop\'s business', async () => {
    answerWith(() => new Response('nope', { status: 500 }));
    const { activeAbortControllers } = await import('../../agent/shared-state.js');
    const { generateImage } = await import('../image-generation.js');
    await generateImage({ agentId: AGENT, modelId: MODEL, prompt: 'a cat' });
    expect(activeAbortControllers.get(AGENT)?.size ?? 0).toBe(0);
  });
});

// ── §2 — the audio / TTS dial, and the job it belongs to ─────────────────────────────────

describe('§2 a stop cuts a TTS / music generation and the job lands in the stop path', () => {
  it('THE RED: the narration call is cut and reports the stop', async () => {
    hangUntilAborted();
    const { generateAudio } = await import('../audio-generation.js');
    const inFlight = generateAudio({
      agentId: AGENT, modelId: MODEL, prompt: 'read this aloud',
      speak: true, sampleRate: 24_000, channels: 1,
    });
    await untilDialled();
    const cut = await stopNow();
    const result = await inFlight;

    expect(cut).toBe(1);
    expect(dials[0].signal?.aborted).toBe(true);
    expect(result.ok === false && result.code).toBe('STOPPED');
  });

  it('THE STOP PATH, NOT THE FAILURE PATH: the job is cancelled, carries no error, and says nothing', async () => {
    // The whole of requirement (b) at the level the owner sees it. Before this, a stop mid-TTS
    // produced `status='failed'`, an `error` column reading "Request failed: This operation was
    // aborted", and an assistant bubble saying *"I wasn't able to finish that audio"* — the
    // engine blaming a provider for the owner's own button.
    hangUntilAborted();
    const jobs = await import('../generation-jobs.js');
    const jobId = jobs.createGenerationJob({
      kind: 'audio', agentId: AGENT, modelId: MODEL, providerId: PROVIDER,
      prompt: 'read this aloud', voice: 'alloy',
    });
    jobs.enqueueAudioOrMusicJob(jobId);
    await untilDialled();
    await stopNow();
    await tick(30);

    const row = mockDb.current!.prepare('SELECT status, error FROM generation_jobs WHERE id = ?')
      .get(jobId) as { status: string; error: string | null };
    expect(row.status).toBe('cancelled');
    expect(row.error, 'a stop has no error to record').toBeNull();

    const said = mockDb.current!.prepare("SELECT content FROM messages WHERE agent_id = ?")
      .all(AGENT) as Array<{ content: string }>;
    expect(said.map((m) => m.content).join('\n')).not.toMatch(/wasn't able to finish/i);
  });

  it('CONTROL: a genuine provider failure still fails the job, with its error and its bubble', async () => {
    answerWith(() => new Response('upstream exploded', { status: 500 }));
    const jobs = await import('../generation-jobs.js');
    const jobId = jobs.createGenerationJob({
      kind: 'audio', agentId: AGENT, modelId: MODEL, providerId: PROVIDER,
      prompt: 'read this aloud', voice: 'alloy',
    });
    jobs.enqueueAudioOrMusicJob(jobId);
    await tick(40);

    const row = mockDb.current!.prepare('SELECT status, error FROM generation_jobs WHERE id = ?')
      .get(jobId) as { status: string; error: string | null };
    expect(row.status, 'a real failure must still be a failure').toBe('failed');
    expect(row.error).toMatch(/HTTP 500/);
    const said = mockDb.current!.prepare("SELECT content FROM messages WHERE agent_id = ?")
      .all(AGENT) as Array<{ content: string }>;
    expect(said.map((m) => m.content).join('\n')).toMatch(/wasn't able to finish/i);
  });
});

// ── §3 — the queued generation the registry cannot reach ─────────────────────────────────

describe('§3 the stop reaches a generation that has not dialled yet', () => {
  it('THE RED: a job still queued when the button is pressed never dials', async () => {
    // `image_create`'s delivery IIFE waits for the turn to END before it generates, so at the
    // instant it finally dials there is nothing registered and no fence standing — the run
    // that was stopped lowered its own fence on the way out. The row is the durable fact.
    const { stopAgent } = await import('../../agent/runtime.js');
    const jobs = await import('../generation-jobs.js');
    const jobId = jobs.createGenerationJob({
      kind: 'image', agentId: AGENT, modelId: MODEL, providerId: PROVIDER, prompt: 'a cat',
    });

    stopAgent(AGENT);

    const row = mockDb.current!.prepare('SELECT status FROM generation_jobs WHERE id = ?')
      .get(jobId) as { status: string };
    expect(row.status).toBe('cancelled');
    // And the CAS the deferred dial goes through refuses it, which is what makes the row
    // load-bearing rather than cosmetic.
    expect(jobs.setRunning(jobId), 'a cancelled job must never move to running').toBe(false);
  });

  it('CONTROL: an unstopped agent\'s queued job is untouched and still runs', async () => {
    const { stopAgent } = await import('../../agent/runtime.js');
    const jobs = await import('../generation-jobs.js');
    const jobId = jobs.createGenerationJob({
      kind: 'image', agentId: AGENT, modelId: MODEL, providerId: PROVIDER, prompt: 'a cat',
    });

    stopAgent('some-other-agent');

    const row = mockDb.current!.prepare('SELECT status FROM generation_jobs WHERE id = ?')
      .get(jobId) as { status: string };
    expect(row.status).toBe('queued');
    expect(jobs.setRunning(jobId)).toBe(true);
  });
});

// ── §4 — the video submit ────────────────────────────────────────────────────────────────

describe('§4 a stop cuts the video submit', () => {
  it('THE RED: the submit is cut, reports the stop, and leaves no job row behind', async () => {
    hangUntilAborted();
    const { submitVideoJob } = await import('../video-generation.js');
    const inFlight = submitVideoJob({
      modelId: MODEL, agentId: AGENT, prompt: 'a cat',
      paramSpec: { params: [] } as never, canonicalParams: {},
    });
    await untilDialled();
    const cut = await stopNow();
    const submit = await inFlight;

    expect(cut).toBe(1);
    expect(dials[0].signal?.aborted).toBe(true);
    expect(submit.ok === false && submit.code).toBe('STOPPED');
    const rows = mockDb.current!.prepare('SELECT id FROM video_jobs').all();
    expect(rows, 'a submit that never landed must not leave a job to poll').toEqual([]);
  });
});

// ── §5 — the poller, which a per-call registration alone cannot reach ────────────────────

describe('§5 a stop stops the video poll loop, including while it is asleep', () => {
  function queueVideoJob(): string {
    const id = 'vid_a5test';
    mockDb.current!.prepare(`
      INSERT INTO video_jobs (id, agent_id, model_id, provider_id, provider_job_id, prompt, status, attempt_count)
      VALUES (?, ?, ?, ?, 'prov-job-1', 'a cat', 'queued', 0)
    `).run(id, AGENT, MODEL, PROVIDER);
    return id;
  }

  it('THE RED: a stop landing during the backoff sleep ends the loop in milliseconds, cancelled', async () => {
    // The provider says "still working" forever, so the loop settles into its backoff sleep —
    // `POLL_START_MS` is 5 s. An un-woken sleep is an orphaned poller: it would keep the job
    // alive for another five seconds and then poll again, for a run the owner stopped.
    answerWith((url) => url.endsWith('/cancel')
      ? new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response(JSON.stringify({ status: 'in_progress', progress: 20 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    const { enqueueVideoJob } = await import('../video-job-poller.js');
    const jobId = queueVideoJob();

    enqueueVideoJob(jobId);
    await untilDialled();      // the first poll leg has happened; the loop is now asleep
    await tick(20);

    const t0 = Date.now();
    await stopNow();
    // Poll the row rather than sleeping a fixed span, so the assertion measures the loop's
    // reaction and not the test's patience.
    let status = '';
    for (let i = 0; i < 200; i += 1) {
      status = (mockDb.current!.prepare('SELECT status FROM video_jobs WHERE id = ?')
        .get(jobId) as { status: string }).status;
      if (status !== 'queued' && status !== 'polling') break;
      await tick(5);
    }
    const elapsed = Date.now() - t0;

    expect(status, 'a stopped video job is cancelled, never failed').toBe('cancelled');
    expect(elapsed, 'the loop must wake on the stop, not on the next 5 s tick').toBeLessThan(2_000);

    const row = mockDb.current!.prepare('SELECT error FROM video_jobs WHERE id = ?')
      .get(jobId) as { error: string | null };
    expect(row.error, 'a stop has no error to record').toBeNull();
    const said = mockDb.current!.prepare('SELECT content FROM messages WHERE agent_id = ?')
      .all(AGENT) as Array<{ content: string }>;
    expect(said.map((m) => m.content).join('\n')).not.toMatch(/wasn't able to finish/i);
  });

  it('the provider-side job is cancelled too, so the stop also stops the GPU time being billed', async () => {
    answerWith((url) => url.endsWith('/cancel')
      ? new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response(JSON.stringify({ status: 'in_progress' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    const { enqueueVideoJob } = await import('../video-job-poller.js');
    const jobId = queueVideoJob();
    enqueueVideoJob(jobId);
    await untilDialled();
    await stopNow();
    for (let i = 0; i < 200 && !dials.some((d) => d.url.endsWith('/cancel')); i += 1) await tick(5);

    expect(dials.some((d) => d.url.endsWith('/cancel')), 'the provider was told to stop').toBe(true);
  });

  it('CONTROL: with no stop, the same loop keeps polling and the row stays active', async () => {
    answerWith(() => new Response(JSON.stringify({ status: 'in_progress' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const { enqueueVideoJob } = await import('../video-job-poller.js');
    const jobId = queueVideoJob();
    enqueueVideoJob(jobId);
    await untilDialled();
    await tick(50);

    const row = mockDb.current!.prepare('SELECT status FROM video_jobs WHERE id = ?')
      .get(jobId) as { status: string };
    expect(['queued', 'polling'], 'an unstopped job must keep polling').toContain(row.status);
    expect(dials.some((d) => d.url.endsWith('/cancel')), 'nothing was cancelled').toBe(false);
  });

  it('CONTROL: a provider that reports failure still produces a FAILED job, with its bubble', async () => {
    answerWith(() => new Response(JSON.stringify({ status: 'failed', error: 'model refused' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const { enqueueVideoJob } = await import('../video-job-poller.js');
    const jobId = queueVideoJob();
    enqueueVideoJob(jobId);
    for (let i = 0; i < 200; i += 1) {
      const s = (mockDb.current!.prepare('SELECT status FROM video_jobs WHERE id = ?')
        .get(jobId) as { status: string }).status;
      if (s === 'failed') break;
      await tick(5);
    }
    const row = mockDb.current!.prepare('SELECT status, error FROM video_jobs WHERE id = ?')
      .get(jobId) as { status: string; error: string | null };
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/model refused/);
  });
});

// ── §6 — transcription, the media dial that runs INSIDE the turn ─────────────────────────

describe('§6 a stop cuts a transcription in flight', () => {
  it('THE RED: the cloud transcription call is cut and reports the stop', async () => {
    hangUntilAborted();
    mockDb.current!.prepare(
      `INSERT INTO config (key, value, updated_at) VALUES ('dojo_transcription_model_id', ?, datetime('now'))`,
    ).run(MODEL);
    const { transcribeAudio } = await import('../transcription.js');
    const inFlight = transcribeAudio({
      agentId: AGENT, audio: Buffer.from('audio-bytes'), mimeType: 'audio/mpeg', filename: 'memo.mp3',
    });
    await untilDialled();
    const cut = await stopNow();
    const result = await inFlight;

    expect(cut).toBe(1);
    expect(dials[0].signal?.aborted).toBe(true);
    expect(result.ok === false && result.code).toBe('STOPPED');
  });

  it('THE RED: the source download is cut too', async () => {
    hangUntilAborted();
    const { fetchAudioUrl } = await import('../transcription.js');
    const inFlight = fetchAudioUrl(AGENT, 'https://example.test/podcast.mp3');
    await untilDialled();
    await stopNow();
    const result = await inFlight;

    expect(dials[0].signal?.aborted).toBe(true);
    expect('stopped' in result && result.stopped).toBe(true);
  });
});

// ── §7 — the census ──────────────────────────────────────────────────────────────────────

describe('§7 the census: every media dial goes through the one door', () => {
  const MEDIA_SERVICES = [
    'services/image-generation.ts',
    'services/audio-generation.ts',
    'services/video-generation.ts',
    'services/transcription.ts',
  ];
  const textOf = (rel: string) => fs.readFileSync(path.join(SRC_ROOT, rel), 'utf-8');

  it('every media generator file registers through `openAgentCall`', () => {
    const missing = MEDIA_SERVICES.filter((f) => !/openAgentCall\(/.test(textOf(f)));
    expect(missing, 'a media file with no registration is a dial a stop cannot reach').toEqual([]);
  });

  it('no media dial takes a BARE clock as its signal — the one exception is the cancel itself', () => {
    // The shape of the defect was `signal: AbortSignal.timeout(…)` with nothing else on it.
    // Exactly one such line may remain in this family: `cancelProviderVideo`, which is the call
    // that ENACTS a cancel. Registering that one would let a stop abort the request that
    // delivers it, leaving the provider generating a clip nobody will ever see.
    const offenders: string[] = [];
    for (const rel of MEDIA_SERVICES) {
      const src = textOf(rel);
      const cancelStart = src.indexOf('export async function cancelProviderVideo');
      src.split('\n').forEach((line, i) => {
        if (!/signal:\s*AbortSignal\.timeout\(/.test(line)) return;
        const at = src.split('\n').slice(0, i).join('\n').length;
        const insideCancel = cancelStart >= 0 && at > cancelStart;
        if (!insideCancel) offenders.push(`${rel}:${i + 1} — ${line.trim()}`);
      });
    }
    expect(offenders, 'a bare clock on a media dial is a call the stop cannot reach').toEqual([]);
  });

  it('the stop door itself is the registry\'s, not a second copy of it', async () => {
    // `openAgentCall` must go through `registerAbortable` / `releaseAbortable` — the two doors
    // T83's own census keeps as the registry's only writers — rather than touching the map.
    const src = textOf('agent/shared-state.ts');
    const body = src.slice(src.indexOf('export function openAgentCall'));
    expect(/registerAbortable\(/.test(body)).toBe(true);
    expect(/releaseAbortable\(/.test(body)).toBe(true);
  });

  it('`stopAgent` cancels the open run-once jobs the registry cannot reach', () => {
    const src = textOf('agent/runtime.ts');
    const body = src.slice(src.indexOf('export function stopAgent'), src.indexOf('export function stopAgent') + 4000);
    expect(/cancelAgentGenerationJobs\(/.test(body), 'a queued generation outlives the fence').toBe(true);
  });
});
