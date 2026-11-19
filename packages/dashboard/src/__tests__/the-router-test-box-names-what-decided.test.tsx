// The router test box must name what decided, and show the keyword table only when the keyword backup decided.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RouterTest } from '../components/RouterTest';

const run = async (onTest: (p: string) => Promise<unknown>) => {
  render(<RouterTest onTest={onTest as never} />);
  fireEvent.change(screen.getByPlaceholderText('Enter a test prompt...'), { target: { value: 'hello' } });
  fireEvent.click(screen.getByText('Test'));
};

describe('the router test box names what decided', () => {
  it('a meaning match is named and shows no keyword table', async () => {
    await run(vi.fn(async () => ({ scores: [], rawScore: 0.8, confidence: 0.9, tier: 'heavy', selectedModel: 'm-1', method: 'semantic' })));
    await screen.findByText('Meaning match');
    expect(screen.queryByText('Keyword backup scores')).toBeNull();
  });
  it('the keyword backup is named and shows its scores', async () => {
    await run(vi.fn(async () => ({ scores: [{ dimension: 'length', score: 0.5, weight: 1, weighted: 0.5 }], rawScore: 0.5, confidence: 0.6, tier: 'light', selectedModel: 'm-2', method: 'fallback' })));
    await screen.findByText('Keyword backup');
    expect(screen.getByText('Keyword backup scores')).toBeTruthy();
    expect(screen.getByText('length')).toBeTruthy();
  });
});
