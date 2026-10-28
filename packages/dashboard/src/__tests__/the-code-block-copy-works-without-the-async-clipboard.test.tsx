// The code-block and source-block copy buttons used to call navigator.clipboard
// directly, which is undefined on a plain-http address (a LAN or a tunnel), so the
// button did nothing there. They now go through lib/clipboard's execCommand fallback.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Markdown } from '../components/Markdown';

describe('the code block copy works without the async clipboard', () => {
  // The fallback case borrows document.execCommand; hand it back so the mock
  // can't leak into a later test in this worker.
  const originalExecCommand = document.execCommand;
  afterEach(() => {
    document.execCommand = originalExecCommand;
  });

  it('falls back to execCommand when the async Clipboard API is absent', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    document.execCommand = vi.fn(() => true);
    render(<Markdown content={'```js\nconst a = 1;\n```'} />);

    fireEvent.click(screen.getByText('Copy'));
    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(await screen.findByText('Copied!')).toBeDefined();
  });

  it('uses the async Clipboard API in a secure context', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    render(<Markdown content={'```js\nconst a = 1;\n```'} />);

    fireEvent.click(screen.getByText('Copy'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('const a = 1;'));
  });

  it('copies a source block the same way', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    render(<Markdown content={'```source\nhello\n```'} />);

    fireEvent.click(screen.getByText('Copy'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('hello'));
  });
});
