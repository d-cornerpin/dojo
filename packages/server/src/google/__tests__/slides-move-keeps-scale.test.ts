// slides_move_element must keep the element's own scale.
//
// The move writes an ABSOLUTE transform, which replaces the whole matrix.
// Hard-coding scaleX/scaleY: 1 snapped a resized element back to its original
// size (flattening slides_resize_element's work), and flattened any element
// that arrived scaled. The move now reads the element first — the way
// slides_resize_element does — and re-sends its own scale (and shear, when it
// has one) with the new translation.
//
// Driven through the real tool door (executeGoogleSlidesTool); only the HTTP
// client is a double.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const googleRead = vi.fn();
const googleWrite = vi.fn(async (..._a: unknown[]) => ({ ok: true, data: { replies: [] } }));
vi.mock('../client.js', () => ({
  googleRead: (...a: unknown[]) => googleRead(...a),
  googleWrite: (...a: unknown[]) => googleWrite(...a),
}));
vi.mock('../accounts.js', () => ({
  resolveGoogleAccountForTool: () => ({ account: { id: 'acct-1', email: 'agent@example.com', connected: true, enabledServices: null } }),
}));

const { executeGoogleSlidesTool } = await import('../tools-slides.js');

const PRESENTATION = {
  ok: true as const,
  data: {
    slides: [{
      objectId: 's1',
      pageElements: [
        {
          objectId: 'e1',
          size: { width: { magnitude: 1270000 }, height: { magnitude: 635000 } },
          transform: { scaleX: 2, scaleY: 0.5, translateX: 0, translateY: 0, unit: 'EMU' },
        },
        {
          objectId: 'e2',
          size: {},
          transform: { translateX: 5, translateY: 6, unit: 'EMU' },
        },
      ],
    }],
  },
};

/** The transform the move put on the wire for these args. */
async function sentTransform(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  googleWrite.mockClear();
  await executeGoogleSlidesTool('slides_move_element', args, 'agent-1', 'Agent');
  const body = googleWrite.mock.calls[0][2] as {
    requests: Array<{ updatePageElementTransform: { transform: Record<string, unknown> } }>;
  };
  return body.requests[0].updatePageElementTransform.transform;
}

describe('slides_move_element keeps the element scale', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    googleRead.mockResolvedValue(PRESENTATION);
  });

  it('a scaled element is moved at its own scale', async () => {
    expect(await sentTransform({ presentation_id: 'p1', element_id: 'e1', x_pt: 100, y_pt: 50 }))
      .toEqual({ scaleX: 2, scaleY: 0.5, translateX: 1270000, translateY: 635000, unit: 'EMU' });
  });

  it('an element with no scale in its transform is sent scale 1', async () => {
    expect(await sentTransform({ presentation_id: 'p1', element_id: 'e2', x_pt: 100, y_pt: 50 }))
      .toEqual({ scaleX: 1, scaleY: 1, translateX: 1270000, translateY: 635000, unit: 'EMU' });
  });

  it('shearX is carried through, and shearY is omitted when the element has none', async () => {
    googleRead.mockResolvedValue({
      ok: true,
      data: {
        slides: [{
          objectId: 's1',
          pageElements: [{ objectId: 'e3', transform: { scaleX: 1, scaleY: 1, shearX: 0.1, unit: 'EMU' } }],
        }],
      },
    });
    const t = await sentTransform({ presentation_id: 'p1', element_id: 'e3', x_pt: 0, y_pt: 0 });
    expect(t.shearX).toBe(0.1);
    expect(t).not.toHaveProperty('shearY');
  });

  it('an unknown element is reported and nothing is written', async () => {
    const r = await executeGoogleSlidesTool(
      'slides_move_element', { presentation_id: 'p1', element_id: 'nope', x_pt: 10, y_pt: 10 }, 'agent-1', 'Agent');
    expect(r).toBe('Error: Element nope not found');
    expect(googleWrite).not.toHaveBeenCalled();
  });

  it('a failing read is reported and nothing is written', async () => {
    googleRead.mockResolvedValue({ ok: false, error: 'boom' });
    const r = await executeGoogleSlidesTool(
      'slides_move_element', { presentation_id: 'p1', element_id: 'e1', x_pt: 10, y_pt: 10 }, 'agent-1', 'Agent');
    expect(r).toBe('Error reading presentation: boom');
    expect(googleWrite).not.toHaveBeenCalled();
  });
});
