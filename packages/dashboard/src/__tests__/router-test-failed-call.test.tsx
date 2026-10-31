// The router "Test" button must say when the test call failed.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RouterTest } from '../components/RouterTest';

const ok = { scores: [{ dimension: 'length', score: 0.5, weight: 1, weighted: 0.5 }], rawScore: 0.5, confidence: 0.9, tier: 'simple', selectedModel: 'm-1' };

const run = async (onTest: (p: string) => Promise<unknown>) => {
  render(<RouterTest onTest={onTest as never} />);
  fireEvent.change(screen.getByPlaceholderText('Enter a test prompt...'), { target: { value: 'hello' } });
  fireEvent.click(screen.getByText('Test'));
};

describe('router test with a failed call', () => {
  it('shows the error when the call answers with one', async () => {
    await run(vi.fn(async () => ({ error: 'boom' })));
    await screen.findByText('Test failed: boom');
    expect((screen.getByText('Test') as HTMLButtonElement).disabled).toBe(false);
  });
  it('shows the error when the call rejects and re-enables the button', async () => {
    await run(vi.fn(async () => { throw new Error('boom'); }));
    await screen.findByText('Test failed: boom');
    expect((screen.getByText('Test') as HTMLButtonElement).disabled).toBe(false);
  });
  it('a normal result shows the table and no error', async () => {
    await run(vi.fn(async () => ok));
    await screen.findByText('m-1');
    await waitFor(() => expect(screen.queryByText(/Test failed/)).toBeNull());
  });
});
