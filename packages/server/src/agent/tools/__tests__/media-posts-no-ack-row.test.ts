// ════════════════════════════════════════════════════════════════════════════
// THE MEDIA GENERATORS POST NO ACKNOWLEDGMENT ROW (UX-REPAIR T71b)
//
// `loop.ts` states the invariant this file holds, in its own words:
//
//   INVARIANT (Part XIX, sharpened): never insert any persisted message between
//   an assistant `tool_use` and its matching `tool_result`. If we ever want a
//   transient "thinking" indicator, it must be broadcast-only, never written to
//   the messages table.
//
// The four media generators broke it. Each wrote an assistant row on the
// SYNCHRONOUS path of the call — v2.10.3's "synthetic acknowledgment" — and the
// executor runs a `safe` batch through `Promise.all`, so an N-call batch wrote N
// rows, all of them landing between the one `tool_use` row and its one
// `tool_result` row. The owner's report (three parallel `image_create` calls)
// was three junk bubbles: "Let me dig in." / "Right on it." / "Looking into it.",
// drawn independently from the voice-mode filler pool, `turn_number` NULL,
// user-visible. Driven at `63b9064`, rows 71905–71907 between 71904 and 71908.
//
// The ack duty belongs to ONE authority — the F10/T41 start-ack door, where the
// engine detects and the AGENT speaks (owner ruling 2026-07-22, OR2). A canned
// line composed by a tool handler is a second authority that the door cannot
// even see: the row carries no `turn_number`, so `startAckRepliedNow`'s probe
// (`preflight/start-ack.ts`) misses it and the door still asks the model to say
// "on it" — the double ack the owner reported.
//
// WHY THE SYNCHRONOUS PATH IS THE THING MEASURED. The deferred delivery IIFE
// legitimately writes rows later (the caption + the attachment, the failure
// notice) — that is the PAYLOAD, and it lands after the turn, not between the
// pair. So each clause below asserts on what has been written by the time the
// handler's promise resolves, with the generator stalled at its first real
// await. A latch would pass a "one row per turn" test and still fail this one,
// which is the point: the requirement is ZERO, not FEWER.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── The write we are counting ──
// `vi.hoisted` because `vi.mock` is hoisted above the file's own consts, and the
// spy has to exist before the factory runs.
const { insertMessageIfAbsent } = vi.hoisted(() => ({ insertMessageIfAbsent: vi.fn() }));
vi.mock('../../../memory/message-store.js', () => ({ insertMessageIfAbsent }));

// ── Everything the four bodies touch on the way to their return ──
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));
vi.mock('../../agent-status.js', () => ({ writeAgentStatus: () => { /* no-op */ } }));
vi.mock('../util.js', () => ({
  auditLog: () => { /* no-op */ },
  toolsLogger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));
vi.mock('../../../db/connection.js', () => ({
  getDb: () => ({
    prepare: () => ({
      // `status: 'idle'` breaks the delivery IIFE's wait-for-idle poll on its
      // first pass, so the IIFE reaches its first REAL await (the generation
      // call, stalled below) rather than sitting in a 60 s timer.
      get: () => ({ status: 'idle', model_id: null, n: 0 }),
      run: () => ({}),
      all: () => [],
    }),
  }),
}));
vi.mock('../../../services/capabilities.js', () => ({ getModelCapabilities: () => [] }));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'present' }));
vi.mock('../../../services/imessage-bridge.js', () => ({
  getTurnScopedImRecipient: () => null,
  sendIMessageWithAttachment: () => false,
  getDefaultSender: () => null,
}));
vi.mock('../../../costs/tracker.js', () => ({ recordCost: () => { /* no-op */ } }));
vi.mock('../../agent-notice.js', () => ({ postAgentNotice: () => { /* no-op */ } }));

const MODEL = { modelId: 'm1', apiModelId: 'api/m1', providerId: 'p1' };
vi.mock('../../../services/image-gen-model.js', () => ({ getEffectiveImageGenModel: () => MODEL }));
vi.mock('../../../services/audio-gen-model.js', () => ({ getEffectiveAudioGenModel: () => MODEL }));
vi.mock('../../../services/music-gen-model.js', () => ({ getEffectiveMusicGenModel: () => MODEL }));
vi.mock('../../../services/video-gen-model.js', () => ({ getEffectiveVideoGenModel: () => MODEL }));
vi.mock('../../../services/transcription-model.js', () => ({ getEffectiveTranscriptionModel: () => MODEL }));
vi.mock('../../../services/generation-jobs.js', () => ({
  createGenerationJob: () => 'job-1',
  // A-5: `setRunning` answers the CAS now, and `true` is what keeps this file's premise —
  // the delivery IIFE reaching the never-settling generator below, so every row counted here
  // is one the SYNCHRONOUS path wrote.
  setRunning: () => true, setSucceeded: () => {}, setFailed: () => {}, setCancelled: () => true,
  enqueueAudioOrMusicJob: () => {},
}));
// The generator never settles, so the delivery IIFE parks at its first real
// await and every row this file counts is one the SYNCHRONOUS path wrote.
vi.mock('../../../services/image-generation.js', () => ({
  generateImage: () => new Promise(() => { /* never settles */ }),
}));
vi.mock('../../../services/video-generation.js', () => ({
  submitVideoJob: async () => ({ ok: true, jobId: 'vjob-1', providerJobId: 'prov-1' }),
}));
vi.mock('../../../services/video-job-poller.js', () => ({ enqueueVideoJob: () => {} }));
vi.mock('../../../services/generation-params.js', () => ({
  getModelGenerationParams: () => null,
  defaultVideoSpecFor: () => ({}),
  validateCanonicalParams: () => ({ ok: true, normalized: {} }),
  VIDEO_CANONICAL_PARAMS: [],
}));
vi.mock('../../../services/voice-catalog.js', () => ({
  getModelVoiceCatalog: () => null,
  defaultVoiceCatalogFor: () => null,
  isKnownVoice: () => true,
  formatVoiceCatalog: () => '',
}));

import { mediaHandlers } from '../cat/media.js';

const AGENT = 'agent-under-test';

/** One call, answered — with the arguments each generator needs to reach its return. */
async function call(key: string, args: Record<string, unknown>): Promise<string> {
  const handler = mediaHandlers[key];
  expect(handler, `${key} has no handler`).toBeDefined();
  const out = await handler({
    agentId: AGENT,
    name: key,
    args,
    callId: `call-${key}`,
    toolCall: { id: `call-${key}`, name: key, arguments: args },
  });
  expect(out.isError, `${key} refused the call: ${out.content}`).toBe(false);
  return out.content;
}

/** The four generators and the minimal arguments each accepts. */
const GENERATORS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['image_create', { description: 'a chef' }],
  ['tts_create', { text: 'hello there' }],
  ['music_create', { description: 'a short waltz' }],
  ['video_create', { description: 'a chef, walking', duration_seconds: 5, aspect_ratio: '16:9', resolution: '720p' }],
];

beforeEach(() => { insertMessageIfAbsent.mockClear(); });

describe('a media generator writes no message row on the synchronous path', () => {
  for (const [key, args] of GENERATORS) {
    it(`${key} persists nothing between the tool_use and the tool_result`, async () => {
      await call(key, args);
      const written = insertMessageIfAbsent.mock.calls.map(
        (c) => (c[0] as { role?: string; content?: string }),
      );
      expect(
        written,
        `${key} wrote ${written.length} message row(s) on the synchronous path — ` +
        `every one of them lands between the assistant tool_use row and its tool_result row, ` +
        `which loop.ts:564-567 forbids: ${JSON.stringify(written)}`,
      ).toEqual([]);
    });
  }

  // N calls in one batch is the owner's reported shape, and it is the clause a
  // per-turn latch would still fail: three handlers run concurrently through
  // `Promise.all` (execute/index.ts:204) and each one wrote its own row.
  it('three parallel image_create calls persist nothing at all', async () => {
    await Promise.all([
      call('image_create', { description: 'a chef' }),
      call('image_create', { description: 'a pilot' }),
      call('image_create', { description: 'a librarian' }),
    ]);
    expect(
      insertMessageIfAbsent.mock.calls.length,
      'the owner\'s three junk bubbles: one row per concurrent call, no latch of any kind',
    ).toBe(0);
  });
});

describe('the tool result claims no acknowledgment the engine did not make', () => {
  for (const [key, args] of GENERATORS) {
    it(`${key} does not tell the model the user has already been acked`, async () => {
      const content = await call(key, args);
      // The three strings asserted an ack that only the deleted block performed.
      // Left standing, they tell the model to stay silent about work the person
      // has heard nothing about — the start-ack door's whole subject.
      expect(
        /already posted a (?:brief )?"?started"? ?acknowledgment|already posted a brief acknowledgment/i.test(content),
        `${key}'s result still asserts the engine acked the user: ${content}`,
      ).toBe(false);
      expect(
        /do NOT need to write any text/i.test(content),
        `${key}'s result still forbids the text that IS the acknowledgment: ${content}`,
      ).toBe(false);
    });
  }
});
