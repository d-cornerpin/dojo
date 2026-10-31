// The memory summary tree: a condensed summary is the parent of the older
// summaries it was condensed from (links: summaryId = condensed, parentIds = sources).
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Summary } from '@dojo/shared';
import { DagTree } from '../components/DagTree';

const sum = (id: string, depth: number, at: string): Summary =>
  ({
    id, agentId: 'a', depth, kind: depth ? 'condensed' : 'leaf', content: `content of ${id}`,
    tokenCount: 1, earliestAt: at, latestAt: at, descendantCount: 0, createdAt: at,
  } as unknown as Summary);

const rows = () => Array.from(document.querySelectorAll('.dag-row')).map((r) => r.textContent ?? '');

describe('the summary tree', () => {
  it('shows the condensed summary on top, its sources underneath', () => {
    render(
      <DagTree
        summaries={[sum('L1', 0, '2026-10-01T00:00:00Z'), sum('L2', 0, '2026-10-02T00:00:00Z'), sum('C1', 1, '2026-10-03T00:00:00Z')]}
        links={[{ summaryId: 'C1', parentIds: ['L1', 'L2'] }]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain('content of C1');
    fireEvent.click(document.querySelector('.dag-row button')!);
    const after = rows();
    expect(after).toHaveLength(3);
    expect(after[1]).toContain('content of L1');
    expect(after[2]).toContain('content of L2');
  });

  it('a leaf nobody condensed stays a root', () => {
    render(
      <DagTree
        summaries={[sum('L1', 0, '2026-10-01T00:00:00Z'), sum('L2', 0, '2026-10-02T00:00:00Z'), sum('L3', 0, '2026-10-04T00:00:00Z'), sum('C1', 1, '2026-10-03T00:00:00Z')]}
        links={[{ summaryId: 'C1', parentIds: ['L1', 'L2'] }]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    const r = rows();
    expect(r).toHaveLength(2);
    expect(r.some((t) => t.includes('content of L3'))).toBe(true);
    expect(r.some((t) => t.includes('content of L1'))).toBe(false);
  });
});
