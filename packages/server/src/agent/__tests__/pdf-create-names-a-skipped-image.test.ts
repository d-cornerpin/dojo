// ════════════════════════════════════════════════════════════════════════════
// WHAT pdf_create REPORTS IS WHAT IT DREW.
//
// `pdf_create` counted every block it was given as "rendered", even ones it
// skipped — a missing image file, a non-PNG/JPG image, an unknown block type —
// so the agent told the owner the chart was in the report when the PDF never
// contained it. The result now says how many blocks were drawn and names each
// skipped block and why.
//
// The tool goes through the effects facade, so every clause drives the real
// per-call context (`inCall`, the facade-contract shape): an `fs_read` on each
// path the image blocks touch and an `fs_write` tree on the agent's uploads
// folder. The missing PNG is never created. Names invented.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-pdf-create-skipped');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
  };
});

import { mintCallCapability, attachCallCapability, type ResourceGrant } from '../effects/capability.js';
import { runWithToolCallId } from '../turn-state.js';
import { executePdfTool } from '../pdf-tools.js';

const AGENT = 'agent-pdf-test';
const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-pdf-create-skipped');
const UPLOADS = path.join(HOME, '.dojo', 'uploads', AGENT);
const MISSING = path.join(UPLOADS, 'no-such-chart.png');
const TXT = path.join(UPLOADS, 'notes.txt');

/** The REAL per-call context, as the gate loop opens it once per tool call. */
function inCall<T>(grants: ResourceGrant[], tool: string, body: () => T | Promise<T>): Promise<T> {
  return runWithToolCallId(AGENT, 'call-1', async () => {
    attachCallCapability(mintCallCapability({ agentId: AGENT, tool, callId: 'call-1', grants }));
    return body();
  });
}

const grants = (): ResourceGrant[] => [
  { kind: 'fs_read', at: 'path', lexical: MISSING, real: MISSING },
  { kind: 'fs_read', at: 'path', lexical: TXT, real: TXT },
  { kind: 'fs_write', at: 'tree', root: UPLOADS },
];

function drive(args: Record<string, unknown>): Promise<string> {
  return inCall(grants(), 'pdf_create', () => executePdfTool('pdf_create', args, AGENT));
}

beforeAll(() => {
  fs.mkdirSync(UPLOADS, { recursive: true });
  fs.writeFileSync(TXT, 'notes for the report\n');
});

describe('pdf_create names the blocks it skipped', () => {
  it('a missing image is named', async () => {
    const reply = await drive({
      filename: 'a',
      content: [
        { type: 'paragraph', text: 'Hello' },
        { type: 'image', path: MISSING },
      ],
    });
    expect(reply).toContain('1 of 2 block(s) drawn');
    expect(reply).toContain(`Skipped: block 2 (image not found: ${MISSING}).`);
  });

  it('an image that is not PNG or JPG is named', async () => {
    const reply = await drive({
      filename: 'b',
      content: [{ type: 'image', path: TXT }],
    });
    expect(reply).toContain('0 of 1 block(s) drawn');
    expect(reply).toContain(`block 1 (image is not PNG or JPG: ${TXT})`);
  });

  it('an unknown block type is named', async () => {
    const reply = await drive({
      filename: 'c',
      content: [
        { type: 'chart', data: [1] },
        { type: 'heading', text: 'T' },
      ],
    });
    expect(reply).toContain('1 of 2 block(s) drawn');
    expect(reply).toContain('block 1 (unknown type "chart")');
  });

  it('a clean document skips nothing', async () => {
    const reply = await drive({
      filename: 'd',
      content: [
        { type: 'heading', text: 'T' },
        { type: 'paragraph', text: 'P' },
      ],
    });
    expect(reply).toContain('2 of 2 block(s) drawn');
    expect(reply).not.toContain('Skipped:');
  });
});
