// ════════════════════════════════════════
// NUMERIC TOOL ARGS THAT ARRIVE AS STRINGS — squad_recall's limit, set_voice's speed.
//
// Some providers (DeepSeek via OpenRouter, weak Ollama models) emit numeric tool
// args as JSON STRINGS even when the schema says `type: 'number'` — the whole
// reason `pagination.ts`'s `coerceNumberArg` exists, and the way `file_read`
// already reads its offset/limit. Two handlers still used the naive
// `typeof v === 'number'` check, so exactly those providers silently lost the
// arg: `squad_recall` returned the default 5 rows on `{"limit":"20"}`, and
// `set_voice` dropped the speed, answering "Provide a voice and/or a speed to
// change." to a call that HAD given a speed.
//
// The handlers are the unit under test: imported directly, with everything they
// load stubbed, so each clause reads the argument straight off the handler's
// own call.
// ════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── squad_recall's world ──

const searchSpy = vi.fn((_params: unknown) => [] as never[]);
vi.mock('../../../../vault/namespaces.js', () => ({
  resolveAgentNamespace: () => 'squad:a',
  vaultSearchInNamespace: (params: unknown) => searchSpy(params),
  vaultRememberInNamespace: vi.fn(),
}));

vi.mock('../../../../db/connection.js', () => ({
  getDb: () => ({ prepare: () => ({ get: () => undefined }) }),
}));

// ── set_voice's world, plus the heavy modules `platform.ts` imports at load ──

const setVoiceSpy = vi.fn(async (_opts: unknown) => ({ ok: true, message: 'ok' }));
vi.mock('../../../../services/agent-controls.js', () => ({
  setVoice: (opts: unknown) => setVoiceSpy(opts),
}));

vi.mock('../../../../vault/store.js', () => ({
  getUnprocessedConversationCount: () => 0,
}));
vi.mock('../../../../vault/maintenance.js', () => ({
  runDreamingCycle: vi.fn(),
}));
vi.mock('../../../../services/channel-inspect.js', () => ({
  buildChannelInspectReport: () => '',
}));
vi.mock('../../../../gateway/routes/update.js', () => ({
  getUpdateCache: () => null,
  refreshUpdateCache: vi.fn(),
  getUpdateChannel: () => 'stable',
  applyUpdate: vi.fn(),
}));
vi.mock('../../../../costs/tracker.js', () => ({
  getCostSummary: () => ({}),
  getDailySpend: () => 0,
}));
vi.mock('../../../../gateway/ws.js', () => ({
  broadcast: () => undefined,
}));

import { contactsHandlers } from '../contacts.js';
import { platformHandlers } from '../platform.js';
import type { ToolHandler } from '../../handler.js';

const ctx = (handler: ToolHandler, name: string, args: Record<string, unknown>) =>
  handler({ agentId: 'a1', name, args, callId: 'c', toolCall: {} as never });

const recall = (args: Record<string, unknown>) =>
  ctx(contactsHandlers.squad_recall, 'squad_recall', args);
const voice = (args: Record<string, unknown>) =>
  ctx(platformHandlers.set_voice, 'set_voice', args);

beforeEach(() => {
  vi.clearAllMocks();
});

// ── squad_recall's limit ──────────────────────────────────────────────────

describe('squad_recall reads its limit through the coercion the helper exists for', () => {
  it('⚠ a string limit reaches the search as that number, not the default', async () => {
    await recall({ query: 'x', limit: '20' });
    expect(searchSpy).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
  });

  it('a real number still passes through', async () => {
    await recall({ query: 'x', limit: 20 });
    expect(searchSpy).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
  });

  it('an unparseable string falls back to the default 5', async () => {
    await recall({ query: 'x', limit: 'abc' });
    expect(searchSpy).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }));
  });

  it('a zero falls back to the default 5', async () => {
    await recall({ query: 'x', limit: 0 });
    expect(searchSpy).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }));
  });

  it('a fractional string floors down', async () => {
    await recall({ query: 'x', limit: '2.9' });
    expect(searchSpy).toHaveBeenCalledWith(expect.objectContaining({ limit: 2 }));
  });

  it('no limit keeps the default 5', async () => {
    await recall({ query: 'x' });
    expect(searchSpy).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }));
  });
});

// ── set_voice's speed ─────────────────────────────────────────────────────

describe('set_voice reads a string speed as the speed it is', () => {
  it('⚠ a string speed reaches setVoice, and the call is not refused', async () => {
    const r = await voice({ speed: '1.2' });
    expect(setVoiceSpy).toHaveBeenCalledWith({ voice: undefined, speed: 1.2 });
    expect(r.isError).toBe(false);
  });

  it('a real number still passes through', async () => {
    const r = await voice({ speed: 1.2 });
    expect(setVoiceSpy).toHaveBeenCalledWith({ voice: undefined, speed: 1.2 });
    expect(r.isError).toBe(false);
  });

  it('an unparseable speed is still no speed at all — the old refusal stands', async () => {
    const r = await voice({ speed: 'fast' });
    expect(setVoiceSpy).not.toHaveBeenCalled();
    expect(r.isError).toBe(true);
    expect(r.content).toBe('Provide a voice and/or a speed to change.');
  });

  it('a voice alone is untouched by any of this', async () => {
    await voice({ voice: 'Bella' });
    expect(setVoiceSpy).toHaveBeenCalledWith({ voice: 'Bella', speed: undefined });
  });
});
