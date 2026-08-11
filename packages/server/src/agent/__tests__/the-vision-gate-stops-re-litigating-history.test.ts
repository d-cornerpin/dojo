// ════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 6 T27 — THE VISION GATE STOPS RE-LITIGATING HISTORY.
//
// THE INCIDENT, on the dev body 2026-08-10, and it is in every one of the six round-6
// catalogs: ONE stale image row (residue of W9's T23 fixture) sat in BehaviorBot's history.
// The gate walks the assembled history on EVERY model call and remembered nothing, so on every
// call it re-sent that image to the fallback vision model, re-failed —
//
//   22:55:54.572 error model    OpenAI call failed: 400   google/gemini-2.5-flash-image
//   22:55:54.573 warn  runtime  Fallback vision caption failed, falling back to strip
//   22:55:54.573 warn  runtime  Vision gate: stripped images from turn   imagesStripped=1
//
// — re-broadcast an amber `chat:error` toast to the user (11 in 15 minutes), and re-spliced
// "[System: The user just sent 1 image … Do NOT continue any prior topic, respond ONLY about
// the image they just sent]" into the middle of the history. By the second turn that sentence
// is simply false, and it is a topic hijack aimed at whatever the user is actually asking.
//
// THE FIX IS A MEMORY, and the memory is what makes "historical" answerable at all: the gate
// is handed provider-shape blocks and no message id, so first sighting (no stored row) IS the
// arrival turn — toast and nudge fire exactly as they always did — and every later sighting
// reads the store, costs nothing, and says nothing to the user.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
const broadcastSpy = vi.fn();
const capabilitiesMock = vi.fn<(modelId: string) => string[]>(() => []);
const captionCalls: number[] = [];
const captionResult = { text: 'a red bicycle leaning on a blue fence', throwErr: false };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t27-vision', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: (e: unknown) => broadcastSpy(e) }));
vi.mock('../../services/capabilities.js', () => ({
  getModelCapabilities: (m: string) => capabilitiesMock(m),
}));
vi.mock('../../services/vision-model.js', () => ({
  getEffectiveVisionModel: () => ({
    modelId: 'vision-1', providerId: 'p', apiModelId: 'gemini-flash-image', source: 'fallback',
  }),
}));
vi.mock('../model.js', () => ({
  callModel: async () => {
    captionCalls.push(Date.now());
    if (captionResult.throwErr) throw new Error('400 Provider returned error');
    return { content: captionResult.text, toolCalls: [], usage: {} };
  },
}));

import { runMigrations } from '../../db/migrations.js';
import { enforceModelCapabilities } from '../runtime.js';
import { lookupVisionCaption, imageFingerprint, UNCAPTIONED_IMAGE_STUB } from '../../services/vision-captions.js';

type Msg = { role: 'user' | 'assistant'; content: string | unknown[] };

const AGENT = 'behaviorbot';
const MODEL = 'text-only-model';

const imageBlock = (data = 'STALE-FIXTURE-BYTES'): Record<string, unknown> => ({
  type: 'image', source: { type: 'base64', media_type: 'image/png', data },
});

const toasts = (): number =>
  broadcastSpy.mock.calls.filter((c) => (c[0] as { type?: string }).type === 'chat:error').length;

const nudges = (msgs: Msg[]): number =>
  msgs.filter((m) => typeof m.content === 'string' && /just sent \d+ image/.test(m.content)).length;

const flat = (msgs: Msg[]): string =>
  msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  broadcastSpy.mockClear();
  captionCalls.length = 0;
  captionResult.text = 'a red bicycle leaning on a blue fence';
  captionResult.throwErr = false;
  capabilitiesMock.mockReset();
  capabilitiesMock.mockReturnValue(['tools']);   // no vision
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

// ════════════════════════════════════════════════════════════════════
// ARM 1 — THE STALE ROW
// ════════════════════════════════════════════════════════════════════

describe('ARM 1 — a historical image is decided once, not every assembly', () => {
  it('RED: the SAME image across three assemblies toasts once and is asked once', async () => {
    captionResult.throwErr = true;   // the dev body's 400, every time
    for (let turn = 0; turn < 3; turn++) {
      const msgs: Msg[] = [
        { role: 'user', content: [{ type: 'text', text: 'here' }, imageBlock()] },
        { role: 'assistant', content: 'noted' },
        { role: 'user', content: 'what is 15% of $240?' },
      ];
      await enforceModelCapabilities(AGENT, MODEL, msgs as never);
    }
    expect(toasts(), 'today: one amber toast per model call, for ever').toBe(1);
    expect(captionCalls.length, 'the fallback model is asked once about one image').toBe(1);
  });

  it('RED: the "just sent" nudge is not re-spliced into later assemblies', async () => {
    captionResult.throwErr = true;
    const first: Msg[] = [
      { role: 'user', content: [{ type: 'text', text: 'here' }, imageBlock()] },
    ];
    await enforceModelCapabilities(AGENT, MODEL, first as never);
    expect(nudges(first), 'the arrival turn still gets it, byte-identically').toBe(1);

    const later: Msg[] = [
      { role: 'user', content: [{ type: 'text', text: 'here' }, imageBlock()] },
      { role: 'assistant', content: 'I could not read it' },
      { role: 'user', content: 'anyway — what is 15% of $240?' },
    ];
    await enforceModelCapabilities(AGENT, MODEL, later as never);
    expect(nudges(later), 'a false sentence and a topic hijack, every turn').toBe(0);
    expect(flat(later)).toContain(UNCAPTIONED_IMAGE_STUB);
  });

  it('a successful caption is stored and re-used verbatim, with no second model call', async () => {
    const first: Msg[] = [{ role: 'user', content: [imageBlock('BIKE')] }];
    await enforceModelCapabilities(AGENT, MODEL, first as never);
    expect(captionCalls.length).toBe(1);
    expect(flat(first)).toContain('a red bicycle leaning on a blue fence');

    const later: Msg[] = [
      { role: 'user', content: [imageBlock('BIKE')] },
      { role: 'assistant', content: 'nice bike' },
      { role: 'user', content: 'what colour was it?' },
    ];
    await enforceModelCapabilities(AGENT, MODEL, later as never);
    expect(captionCalls.length, 'asked once, ever').toBe(1);
    expect(flat(later), 'the description survives — the model can still discuss the image')
      .toContain('a red bicycle leaning on a blue fence');
    expect(toasts(), 'a captioned image never toasted and still does not').toBe(0);
  });

  it('the decision is on the ledger, keyed on the image itself', async () => {
    captionResult.throwErr = true;
    await enforceModelCapabilities(
      AGENT, MODEL, [{ role: 'user', content: [imageBlock('X')] }] as never,
    );
    const fp = imageFingerprint(imageBlock('X'))!;
    expect(lookupVisionCaption(fp)).toMatchObject({ outcome: 'failed', caption: null });
  });
});

// ════════════════════════════════════════════════════════════════════
// ARM 2 — WHAT IS BYTE-IDENTICAL
// ════════════════════════════════════════════════════════════════════

describe('ARM 2 — the arrival turn is untouched', () => {
  it('a current-turn image on a non-vision model still toasts ONCE, with the nudge', async () => {
    captionResult.throwErr = true;
    const msgs: Msg[] = [{ role: 'user', content: [{ type: 'text', text: 'look' }, imageBlock('NEW')] }];
    await enforceModelCapabilities(AGENT, MODEL, msgs as never);
    expect(toasts()).toBe(1);
    expect(nudges(msgs)).toBe(1);
    expect(flat(msgs)).toContain('Do NOT continue any prior topic');
  });

  it('a vision-capable model is not gated at all — no store row, no call', async () => {
    capabilitiesMock.mockReturnValue(['tools', 'vision']);
    const msgs: Msg[] = [{ role: 'user', content: [imageBlock('SEEN')] }];
    await enforceModelCapabilities(AGENT, MODEL, msgs as never);
    expect(captionCalls.length).toBe(0);
    expect(toasts()).toBe(0);
    expect(lookupVisionCaption(imageFingerprint(imageBlock('SEEN'))!)).toBeNull();
  });

  it('two DIFFERENT images are two decisions', async () => {
    const msgs: Msg[] = [{ role: 'user', content: [imageBlock('A'), imageBlock('B')] }];
    await enforceModelCapabilities(AGENT, MODEL, msgs as never);
    expect(captionCalls.length).toBe(2);
  });

  it('the tools gate is untouched', async () => {
    capabilitiesMock.mockReturnValue(['vision']);   // no tools
    const r = await enforceModelCapabilities(AGENT, MODEL, [{ role: 'user', content: 'hi' }] as never);
    expect(r.useTools).toBe(false);
  });
});
