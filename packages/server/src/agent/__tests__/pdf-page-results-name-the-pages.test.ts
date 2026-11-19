// Every PDF page result names the pages it acted on, counting from 1, and the asked numbers it skipped.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-pdf-results-name-pages');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
  };
});

import { mintCallCapability, attachCallCapability, type ResourceGrant } from '../effects/capability.js';
import { runWithToolCallId } from '../turn-state.js';
import { executePdfTool } from '../pdf-tools.js';

const AGENT = 'agent-pdf-test';
const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-pdf-results-name-pages');
const UPLOADS = path.join(HOME, '.dojo', 'uploads', AGENT);
const SRC = path.join(UPLOADS, 'src.pdf');

/** The REAL per-call context, as the gate loop opens it once per tool call. */
function inCall<T>(grants: ResourceGrant[], tool: string, body: () => T | Promise<T>): Promise<T> {
  return runWithToolCallId(AGENT, 'call-1', async () => {
    attachCallCapability(mintCallCapability({ agentId: AGENT, tool, callId: 'call-1', grants }));
    return body();
  });
}

const grants = (): ResourceGrant[] => [
  { kind: 'fs_read', at: 'path', lexical: SRC, real: SRC },
  { kind: 'fs_write', at: 'tree', root: UPLOADS },
];

function drive(tool: 'pdf_extract_pages' | 'pdf_delete_pages' | 'pdf_rotate_pages' | 'pdf_watermark', args: Record<string, unknown>): Promise<string> {
  return inCall(grants(), tool, () => executePdfTool(tool, args, AGENT));
}

beforeAll(async () => {
  // A stale output file from an earlier run would fake the "no output file" case.
  fs.rmSync(UPLOADS, { recursive: true, force: true });
  fs.mkdirSync(UPLOADS, { recursive: true });
  const doc = await PDFDocument.create();
  doc.addPage();
  doc.addPage();
  doc.addPage();
  fs.writeFileSync(SRC, await doc.save());
});

describe('pdf page results name the pages they acted on', () => {
  it('an extract names its pages and the ones it skipped', async () => {
    const reply = await drive('pdf_extract_pages', { path: SRC, pages: [1, 3, 7], output_filename: 'x1' });
    expect(reply.startsWith('Extracted page(s) 1, 3 →')).toBe(true);
    expect(reply.endsWith(' Skipped 7: this PDF has 3 pages.')).toBe(true);
  });

  it('a delete names the page it removed', async () => {
    const reply = await drive('pdf_delete_pages', { path: SRC, pages: [2], output_filename: 'x2' });
    expect(reply).toContain('Deleted page(s) 2; 2 remain →');
  });

  it('a rotate names its pages and the ones it skipped', async () => {
    const reply = await drive('pdf_rotate_pages', {
      path: SRC, rotations: [{ page: 3, degrees: 90 }, { page: 9, degrees: 90 }], output_filename: 'x3',
    });
    expect(reply).toContain('Rotated page(s) 3 →');
    expect(reply).toContain('Skipped 9: this PDF has 3 pages.');
  });

  it('a watermark names its pages', async () => {
    const reply = await drive('pdf_watermark', { path: SRC, text: 'DRAFT', pages: [1, 2], output_filename: 'x4' });
    expect(reply).toContain('Watermarked page(s) 1, 2 →');
  });

  it('a watermark of only missing pages writes nothing', async () => {
    const reply = await drive('pdf_watermark', { path: SRC, text: 'DRAFT', pages: [8], output_filename: 'x5' });
    expect(reply.startsWith('Error: none of the pages [8] exist in this 3-page PDF (pages count from 1)')).toBe(true);
    expect(fs.existsSync(path.join(UPLOADS, 'x5.pdf'))).toBe(false);
  });
});
