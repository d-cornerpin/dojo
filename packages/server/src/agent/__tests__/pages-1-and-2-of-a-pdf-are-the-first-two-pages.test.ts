// Every PDF page number counts from 1; a number that is not a page of the file is dropped, never guessed about.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-pdf-pages-count-from-1');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
  };
});

import { mintCallCapability, attachCallCapability, type ResourceGrant } from '../effects/capability.js';
import { runWithToolCallId } from '../turn-state.js';
import { executePdfTool } from '../pdf-tools.js';

const AGENT = 'agent-pdf-test';
const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-pdf-pages-count-from-1');
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

type PdfPageTool = 'pdf_extract_pages' | 'pdf_delete_pages' | 'pdf_rotate_pages' | 'pdf_get_info' | 'pdf_reorder_pages';

function drive(tool: PdfPageTool, args: Record<string, unknown>): Promise<string> {
  return inCall(grants(), tool, () => executePdfTool(tool, args, AGENT));
}

/** The width of every page of a file, rounded to whole points. */
async function widths(file: string): Promise<number[]> {
  const doc = await PDFDocument.load(fs.readFileSync(file));
  return doc.getPages().map((p) => Math.round(p.getWidth()));
}

beforeAll(async () => {
  fs.rmSync(UPLOADS, { recursive: true, force: true });
  fs.mkdirSync(UPLOADS, { recursive: true });
  // Page n (counting from 1) is 100 + n points wide.
  const doc = await PDFDocument.create();
  for (let n = 1; n <= 5; n++) doc.addPage([100 + n, 200]);
  fs.writeFileSync(SRC, await doc.save());
});

describe('every page number counts from 1', () => {
  it('pages 1 and 2 are the first two pages', async () => {
    await drive('pdf_extract_pages', { path: SRC, pages: [1, 2], output_filename: 'first-two' });
    expect(await widths(path.join(UPLOADS, 'first-two.pdf'))).toEqual([101, 102]);
  });

  it('deleting pages 1 and 2 keeps 3, 4 and 5', async () => {
    await drive('pdf_delete_pages', { path: SRC, pages: [1, 2], output_filename: 'del' });
    expect(await widths(path.join(UPLOADS, 'del.pdf'))).toEqual([103, 104, 105]);
  });

  it('rotating page 1 turns the first page', async () => {
    await drive('pdf_rotate_pages', {
      path: SRC, rotations: [{ page: 1, degrees: 90 }], output_filename: 'rot',
    });
    const doc = await PDFDocument.load(fs.readFileSync(path.join(UPLOADS, 'rot.pdf')));
    expect(doc.getPage(0).getRotation().angle).toBe(90);
    expect(doc.getPage(1).getRotation().angle).toBe(0);
  });

  it('page 0 is refused', async () => {
    const reply = await drive('pdf_extract_pages', { path: SRC, pages: [0], output_filename: 'zero' });
    expect(reply.startsWith('Error: none of the pages [0] exist in this 5-page PDF (pages count from 1)')).toBe(true);
  });

  it('a reorder list that starts at 0 is refused and says pages count from 1', async () => {
    const reply = await drive('pdf_reorder_pages', { path: SRC, new_order: [0, 1, 2, 3, 4], output_filename: 'reorder' });
    expect(reply).toContain('pages count from 1');
  });

  it('the info names pages from 1', async () => {
    const reply = await drive('pdf_get_info', { path: SRC });
    expect(reply).toContain('"page": 1');
    expect(reply).not.toContain('"index"');
  });
});
