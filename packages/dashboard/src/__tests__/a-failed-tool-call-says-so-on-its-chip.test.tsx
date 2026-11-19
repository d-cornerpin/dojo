import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToolBadgeGroup, type ToolChipData } from '../components/ToolBadge';

const chip = (key: string, name: string, isError: boolean): ToolChipData => ({ key, name, input: {}, result: isError ? 'not found' : 'ok', isError });

describe('a failed tool call says so on its chip', () => {
  it('a single failed chip reads "(failed)"; a good one does not', () => {
    render(<ToolBadgeGroup items={[]} chips={[chip('k1', 'web_fetch', true), chip('k2', 'file_read', false)]} />);
    expect(screen.getByRole('button', { name: 'web_fetch (failed)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'file_read' })).toBeTruthy();
  });
  it('a group says how many failed', () => {
    render(<ToolBadgeGroup items={[]} chips={[chip('k1', 'web_fetch', true), chip('k2', 'web_fetch', false), chip('k3', 'web_fetch', true)]} />);
    expect(screen.getByRole('button', { name: 'web_fetch, 3 calls, 2 failed (expand)' })).toBeTruthy();
  });
});
