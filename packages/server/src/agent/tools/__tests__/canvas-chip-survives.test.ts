// ════════════════════════════════════════════════════════════════════════════
// THE DOWNLOAD URL AND THE CANVAS CHIP SURVIVE THE CONVERSION
// (PHASE-5 T8 Step 3 — `agent/tools/util.ts`, converted LAST and for this reason).
//
// `util.ts` holds three filesystem PROBES that every category leans on:
// `registerSharedFile` stats a file before minting its download URL,
// `queueCanvasDocAttachment` stats it before dropping the "Open in canvas" chip,
// and `openFileInCanvas` probes for it before opening the dock. All three answer
// their own `catch` with `null` / `{ opened: false }` — which is the right shape
// for a missing file and the WRONG shape for a refusal, because a refusal would
// then be indistinguishable from "the file is not there": no error, no log the
// user sees, just a reply that quietly stops carrying a link.
//
// That is why this module converts after every caller's declaration was
// corrected, and why this file exists. It is written to pass BEFORE the
// conversion and to pass identically after it — the behaviour is the oracle, and
// the conversion is only honest if the oracle does not move.
//
// The companion clause lives in `agent/effects/__tests__/facade-contract.test.ts`
// ("EVERY CALLER of the util probes declares the path it hands them"): this file
// proves the behaviour, that one proves the ten call sites are covered.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const broadcasts: Array<{ type: string }> = [];
const chips: Array<{ fileId: string; path: string }> = [];
let currentCanvas: { kind: string; path?: string } | null = null;

vi.mock('../../../gateway/ws.js', () => ({
  broadcast: (msg: { type: string }): void => { broadcasts.push(msg); },
}));
vi.mock('../../../db/connection.js', () => ({
  getDb: (): unknown => ({ prepare: () => ({ run: () => undefined, get: () => undefined }) }),
}));
vi.mock('../../../services/tunnel.js', () => ({
  getTunnelStatus: (): unknown => ({ status: 'inactive', url: null }),
}));
vi.mock('../../pending-attachments.js', () => ({
  queueCanvasDoc: (_agentId: string, doc: { fileId: string; path: string }): void => { chips.push(doc); },
}));
vi.mock('../../canvas-state.js', () => ({
  getCurrentCanvas: (): unknown => currentCanvas,
  setCurrentCanvas: (_a: string, c: { kind: string; path?: string }): void => { currentCanvas = c; },
}));

const { registerSharedFile, queueCanvasDocAttachment, syncCanvasAfterWrite, openFileInCanvas } =
  await import('../util.js');
const { mintCallCapability, attachCallCapability } = await import('../../effects/capability.js');
const { runWithToolCallId } = await import('../../turn-state.js');
type ResourceGrant = import('../../effects/capability.js').ResourceGrant;

const AGENT = 'canvas-chip-agent';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-chip-'));
const doc = path.join(scratch, 'report.md');
fs.writeFileSync(doc, '# a document the user should be able to open\n');
const missing = path.join(scratch, 'never-written.md');

function inCall<T>(grants: ResourceGrant[], tool: string, body: () => T): Promise<T> {
  return runWithToolCallId(AGENT, 'call-1', async () => {
    attachCallCapability(mintCallCapability({ agentId: AGENT, tool, callId: 'call-1', grants }));
    return body();
  });
}

const readGrant = (p: string): ResourceGrant => ({ kind: 'fs_read', at: 'path', lexical: p, real: p });

beforeEach(() => {
  broadcasts.length = 0;
  chips.length = 0;
  currentCanvas = null;
});

describe('the util probes keep answering for a path the call declared', () => {
  it('registerSharedFile mints the download URL', async () => {
    const url = await inCall([readGrant(doc)], 'file_write', () => registerSharedFile(AGENT, doc));
    expect(url, 'the user gets a link').toMatch(/^http:\/\/localhost:\d+\/api\/upload\/download\/[0-9a-f-]{36}$/);
  });

  it('queueCanvasDocAttachment drops the "Open in canvas" chip', async () => {
    await inCall([readGrant(doc)], 'canvas_render', () => {
      queueCanvasDocAttachment(AGENT, doc, 'http://localhost:3001/api/upload/download/abc-123');
    });
    expect(chips, 'exactly one chip, for this file').toHaveLength(1);
    expect(chips[0].path).toBe(doc);
    expect(chips[0].fileId).toBe('abc-123');
  });

  it('syncCanvasAfterWrite AUTO-OPENS a renderable file it just wrote', async () => {
    const result = await inCall([readGrant(doc)], 'file_write', () =>
      syncCanvasAfterWrite(AGENT, doc, 'http://localhost:3001/api/upload/download/abc-123'));
    expect(result.opened, 'the doc lands in the canvas without the model asking').toBe(true);
    expect(broadcasts.map((b) => b.type)).toEqual(['dock:open']);
    expect(chips).toHaveLength(1);
  });

  it('openFileInCanvas opens an arbitrary on-disk file', async () => {
    const result = await inCall([readGrant(doc)], 'pdf_create', () => openFileInCanvas(AGENT, doc));
    expect(result.opened).toBe(true);
    expect(broadcasts.map((b) => b.type)).toEqual(['dock:open']);
    expect(chips).toHaveLength(1);
  });
});

describe('…and on a file it cannot see, the answer is the one it has always given', () => {
  // The `catch`-to-null shape is preserved deliberately: a helper that started
  // THROWING would turn a best-effort UI chip into a failed tool call, which is
  // a behaviour change in the other direction. What must never happen is a
  // refusal that LOOKS like success, and there is no such shape here.
  it('a missing file yields no URL, no chip and no throw', async () => {
    const url = await inCall([readGrant(missing)], 'file_write', () => registerSharedFile(AGENT, missing));
    expect(url).toBeNull();
    await inCall([readGrant(missing)], 'canvas_render', () => {
      queueCanvasDocAttachment(AGENT, missing, 'http://localhost:3001/api/upload/download/abc-123');
    });
    expect(chips).toEqual([]);
    const opened = await inCall([readGrant(missing)], 'pdf_create', () => openFileInCanvas(AGENT, missing));
    expect(opened).toEqual({ opened: false });
  });

  it('a non-renderable extension still pings the canvas and still hands back its URL', async () => {
    const zip = path.join(scratch, 'bundle.zip');
    fs.writeFileSync(zip, 'PK');
    const result = await inCall([readGrant(zip)], 'file_write', () =>
      syncCanvasAfterWrite(AGENT, zip, 'http://localhost:3001/api/upload/download/abc-123'));
    expect(result.opened, 'a zip is not canvas-renderable').toBe(false);
    expect(broadcasts.map((b) => b.type), 'but the open canvas is still told').toEqual(['canvas:updated']);
    expect(chips).toEqual([]);
    const url = await inCall([readGrant(zip)], 'file_write', () => registerSharedFile(AGENT, zip));
    expect(url, 'and the download link is still minted').not.toBeNull();
  });
});
