// ════════════════════════════════════════════════════════════════════════════
// TASK 970: AN OVERSIZE ATTACHMENT SAYS SO.
//
// The owner dropped a video bigger than the composer's 1 GB cap. `addFiles`
// answered by skipping it with a bare `continue` (and by stopping at the 2 GB
// per-message cap with a bare `break`), then set the orb's SUCCESS emotion and
// dropped back to text mode — so the owner saw the same thing they see when an
// attachment lands, and the file was simply not there. A silent refusal is not
// a refusal: the composer now names what it did not take, and it only smiles
// when it actually took something.
//
// The oversize file's `size` is DEFINED rather than allocated. The limit is a
// number the composer reads off the File; a test that really built a gigabyte
// would spend a gigabyte of RAM proving one comparison.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, type RenderResult } from '@testing-library/react';
import { ToastProvider, ToastContainer } from '../hooks/useToast';

// The house pattern: mock the door, never reach a live server. The composer
// itself only uploads on send, but the voice hook it mounts reads settings
// through the same door.
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function'
      ? vi.fn(async () => ({ ok: true, data: [] }))
      : actual[key];
  }
  stub.getToken = vi.fn(() => null);
  stub.clearToken = vi.fn(() => undefined);
  return stub;
});

import { Dojo3Composer } from '../components/Dojo3Composer';

const GB = 1024 ** 3;

/** The real toast queue, so the assertion is on the words the owner sees. */
const mount = (): RenderResult => render(
  <ToastProvider>
    <ToastContainer />
    <Dojo3Composer agentId="primary" onSend={() => {}} />
  </ToastProvider>,
);

/** A file whose SIZE is a number with no bytes behind it. */
function fileOf(name: string, type: string, size: number): File {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

/** Hand the composer's own hidden picker a selection — the same door its
 *  attach button clicks (`fileInputRef.current.click()`), and the same one a
 *  drag-and-drop feeds through `addFiles`. */
function chooseFiles(view: RenderResult, ...files: File[]): void {
  const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, get: () => files });
  fireEvent.change(input);
}

/* The composer cross-fades two layers — thumbs for text mode, chips for file
   mode — and BOTH are in the DOM; CSS picks which one you see. So "is it
   staged?" counts what either layer carries rather than one of them. */
const stagedFor = (name: string) => screen.queryAllByRole('button', { name: `Remove ${name}` });

describe('an oversize attachment', () => {
  it('names the file it refused, and attaches nothing', () => {
    const view = mount();
    chooseFiles(view, fileOf('holiday-movie.mov', 'video/quicktime', GB + 1));

    const toast = screen.getByText(/holiday-movie\.mov/);
    expect(toast.textContent, 'the refusal does not say it was the size limit').toMatch(/limit/);
    expect(stagedFor('holiday-movie.mov'), 'the refused file is staged anyway').toHaveLength(0);
    expect(
      screen.queryByLabelText('Attached files'),
      'an attachment row appeared for a file that was never taken',
    ).toBeNull();
  });

  it('a file under the limit is attached, and nothing is said', () => {
    const view = mount();
    chooseFiles(view, fileOf('notes.txt', 'text/plain', 2048));

    expect(stagedFor('notes.txt'), 'the accepted file is not staged').not.toHaveLength(0);
    expect(screen.queryByText(/limit/), 'an accepted file was complained about').toBeNull();
  });
});
