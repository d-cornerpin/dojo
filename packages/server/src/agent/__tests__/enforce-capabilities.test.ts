// Unit tests for enforceModelCapabilities. The function gates two things:
//   1. Vision: strip image blocks for models without `vision` capability.
//      PDFs (`document` blocks) are NOT stripped — every provider translator
//      handles them (Anthropic native, OpenAI/Ollama via pdf-extract).
//   2. Tools: signal whether to send tool defs to the provider.
//
// Bug fix 2026-05-04 — the old code stripped PDFs too, which silently
// broke PDF input on every non-vision model even though the translators
// could have handled them. These tests pin the corrected behavior.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const broadcastSpy = vi.fn();
const capabilitiesMock = vi.fn<(modelId: string) => string[]>(() => []);

vi.mock('../../gateway/ws.js', () => ({
  broadcast: (event: unknown) => broadcastSpy(event),
}));

vi.mock('../../services/capabilities.js', () => ({
  getModelCapabilities: (modelId: string) => capabilitiesMock(modelId),
}));

import { enforceModelCapabilities } from '../runtime.js';

beforeEach(() => {
  broadcastSpy.mockClear();
  capabilitiesMock.mockReset();
});

function imageBlock() {
  return {
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'AAA' },
  };
}

function documentBlock(title = 'doc.pdf') {
  return {
    type: 'document' as const,
    source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: 'AAA' },
    title,
  };
}

describe('enforceModelCapabilities — vision gate (#PDF-fix)', () => {
  it('strips images for non-vision model and broadcasts banner', () => {
    capabilitiesMock.mockReturnValue(['tools']); // no vision
    const messages: Array<{ role: 'user' | 'assistant'; content: string | unknown[] }> = [
      { role: 'user', content: [{ type: 'text', text: 'look' }, imageBlock()] },
    ];
    enforceModelCapabilities('primary', 'm1', messages as never);
    // Image gone, text kept.
    expect(typeof messages[0].content === 'string' || (messages[0].content as unknown[]).every((b: unknown) => (b as { type: string }).type === 'text')).toBe(true);
    // Banner fired exactly once.
    const banners = broadcastSpy.mock.calls.filter(([e]) => (e as { type: string }).type === 'chat:error');
    expect(banners).toHaveLength(1);
  });

  it('does NOT strip PDFs for non-vision model — leaves document block intact', () => {
    capabilitiesMock.mockReturnValue(['tools']); // no vision
    const messages: Array<{ role: 'user' | 'assistant'; content: string | unknown[] }> = [
      { role: 'user', content: [{ type: 'text', text: 'summarize this' }, documentBlock('q4-report.pdf')] },
    ];
    enforceModelCapabilities('primary', 'm1', messages as never);
    expect(Array.isArray(messages[0].content)).toBe(true);
    const blocks = messages[0].content as Array<{ type: string }>;
    expect(blocks.find((b) => b.type === 'document')).toBeDefined();
    // No banner — nothing was stripped.
    const banners = broadcastSpy.mock.calls.filter(([e]) => (e as { type: string }).type === 'chat:error');
    expect(banners).toHaveLength(0);
  });

  it('strips images but keeps PDFs in mixed-content message', () => {
    capabilitiesMock.mockReturnValue(['tools']);
    const messages: Array<{ role: 'user' | 'assistant'; content: string | unknown[] }> = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'compare' },
          imageBlock(),
          documentBlock('reference.pdf'),
        ],
      },
    ];
    enforceModelCapabilities('primary', 'm1', messages as never);
    const blocks = messages[0].content as Array<{ type: string }>;
    expect(blocks.find((b) => b.type === 'image')).toBeUndefined();
    expect(blocks.find((b) => b.type === 'document')).toBeDefined();
    expect(blocks.find((b) => b.type === 'text')).toBeDefined();
    // Banner mentions images only, not PDFs.
    const banners = broadcastSpy.mock.calls.filter(([e]) => (e as { type: string }).type === 'chat:error');
    expect(banners).toHaveLength(1);
    const errorText = (banners[0][0] as { error: string }).error;
    expect(errorText).toMatch(/images/i);
    expect(errorText).not.toMatch(/pdf was dropped/i);
  });

  it('leaves images alone for vision-capable model', () => {
    capabilitiesMock.mockReturnValue(['tools', 'vision']);
    const messages: Array<{ role: 'user' | 'assistant'; content: string | unknown[] }> = [
      { role: 'user', content: [{ type: 'text', text: 'what' }, imageBlock()] },
    ];
    enforceModelCapabilities('primary', 'm1', messages as never);
    const blocks = messages[0].content as Array<{ type: string }>;
    expect(blocks.find((b) => b.type === 'image')).toBeDefined();
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('strips images nested inside tool_result blocks too', () => {
    capabilitiesMock.mockReturnValue(['tools']);
    const messages: Array<{ role: 'user' | 'assistant'; content: string | unknown[] }> = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu1',
            content: [imageBlock()],
          },
        ],
      },
    ];
    enforceModelCapabilities('primary', 'm1', messages as never);
    const blocks = messages[0].content as Array<{ type: string; content?: Array<{ type: string }> }>;
    const tr = blocks[0];
    expect(tr.type).toBe('tool_result');
    // Inner content should have been replaced by a text note (no images left).
    expect(tr.content?.find((b) => b.type === 'image')).toBeUndefined();
    expect(tr.content?.find((b) => b.type === 'text')).toBeDefined();
  });
});

describe('enforceModelCapabilities — tools gate', () => {
  it('returns useTools=true for tools-capable model', () => {
    capabilitiesMock.mockReturnValue(['tools', 'vision']);
    const r = enforceModelCapabilities('primary', 'm1', []);
    expect(r.useTools).toBe(true);
  });

  it('returns useTools=false for tools-incapable model', () => {
    capabilitiesMock.mockReturnValue(['vision']); // no tools
    const r = enforceModelCapabilities('primary', 'm-no-tools', []);
    expect(r.useTools).toBe(false);
  });

  it('returns useTools=true on unknown capabilities (optimistic)', () => {
    capabilitiesMock.mockReturnValue([]); // probe returned nothing
    const r = enforceModelCapabilities('primary', 'm-unknown', []);
    expect(r.useTools).toBe(true);
  });
});
