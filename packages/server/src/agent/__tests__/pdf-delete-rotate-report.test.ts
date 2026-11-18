// ════════════════════════════════════════════════════════════════════════════
// WHAT THE PDF PAGE TOOLS REPORT IS WHAT THEY CHANGED.
//
// `pdf_delete_pages` and `pdf_rotate_pages` reported what the agent ASKED FOR
// (`pages.length`, `rotations.length`) instead of what actually changed: a
// delete of pages that do not exist claimed pages gone and saved a copy; a
// rotate of an out-of-range page claimed rotations that never happened. The
// agent then told the user about work the file never saw. `pdf_extract_pages`
// already refused when no valid index remained.
//
// Both halves are pinned here: an all-out-of-range request answers with an
// error and writes NO output file, and a mixed request reports the count of
// what actually changed.
//
// The file helpers go through the effects facade, so every clause drives the
// real per-call context (`inCall`, the facade-contract shape): an `fs_read`
// on the source and an `fs_write` tree on the agent's uploads folder — the
// same declaration the tool schemas carry, and what also covers the mkdir of
// that folder. A 3-page fixture is built here with pdf-lib. Names invented.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-pdf-delete-rotate-report');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
  };
});

import { mintCallCapability, attachCallCapability, type ResourceGrant } from '../effects/capability.js';
import { runWithToolCallId } from '../turn-state.js';
import { executePdfTool } from '../pdf-tools.js';

const AGENT = 'agent-pdf-test';
const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-pdf-delete-rotate-report');
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

function drive(tool: 'pdf_delete_pages' | 'pdf_rotate_pages', args: Record<string, unknown>): Promise<string> {
  return inCall(grants(), tool, () => executePdfTool(tool, args, AGENT));
}

beforeAll(async () => {
  // A fixture-shaped uploads folder: a stale out*.pdf from an earlier run
  // would fake the "no output file" assertions.
  fs.rmSync(UPLOADS, { recursive: true, force: true });
  fs.mkdirSync(UPLOADS, { recursive: true });
  const doc = await PDFDocument.create();
  doc.addPage();
  doc.addPage();
  doc.addPage();
  fs.writeFileSync(SRC, await doc.save());
});

describe('pdf_delete_pages reports the pages it actually removed', () => {
  it('pages past the end are refused, and no output file is written', async () => {
    const reply = await drive('pdf_delete_pages', { path: SRC, pages: [7], output_filename: 'out1' });
    expect(reply.startsWith('Error: none of the pages [7] exist in this 3-page PDF')).toBe(true);
    expect(fs.existsSync(path.join(UPLOADS, 'out1.pdf'))).toBe(false);
  });

  it('a repeated index counts once', async () => {
    const reply = await drive('pdf_delete_pages', { path: SRC, pages: [1, 1], output_filename: 'out2' });
    expect(reply).toContain('Deleted page(s) 1; 2 remain');
  });

  it('one in-range page deletes exactly as before', async () => {
    const reply = await drive('pdf_delete_pages', { path: SRC, pages: [2], output_filename: 'out3' });
    expect(reply).toContain('Deleted page(s) 2; 2 remain');
  });
});

describe('pdf_rotate_pages reports the rotations it actually applied', () => {
  it('a page past the end is refused, and no output file is written', async () => {
    const reply = await drive('pdf_rotate_pages', {
      path: SRC, rotations: [{ page: 9, degrees: 90 }], output_filename: 'out4',
    });
    expect(reply.startsWith('Error: none of the requested pages exist')).toBe(true);
    expect(fs.existsSync(path.join(UPLOADS, 'out4.pdf'))).toBe(false);
  });

  it('an out-of-range rotation inside a mixed request is not counted', async () => {
    const reply = await drive('pdf_rotate_pages', {
      path: SRC, rotations: [{ page: 1, degrees: 90 }, { page: 9, degrees: 90 }], output_filename: 'out5',
    });
    expect(reply).toContain('Rotated page(s) 1 →');
  });
});
