import { useState, useMemo } from 'react';
import type { Summary } from '@dojo/shared';
import { parseUtc } from '../lib/dates';

interface DagLink {
  summaryId: string;
  parentIds: string[];
}

interface DagTreeProps {
  summaries: Summary[];
  links: DagLink[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const DEPTH_COLORS: Record<number, string> = {
  0: 'bg-cp-blue',
  1: 'bg-cp-teal',
  2: 'bg-cp-amber',
};

const getDepthColor = (depth: number): string => {
  return DEPTH_COLORS[depth] ?? 'bg-cp-purple';
};

const formatTimeRange = (earliest: string, latest: string): string => {
  // `summaries.earliest_at`/`latest_at` carry the message store's Z-less UTC text
  // (`memory/store.ts:createdAtText`), so they must be parsed as UTC.
  const e = parseUtc(earliest);
  const l = parseUtc(latest);
  if (!e || !l) return '';
  const fmt = (d: Date) =>
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (fmt(e) === fmt(l)) return fmt(e);
  return `${fmt(e)} - ${fmt(l)}`;
};

interface TreeNodeProps {
  summary: Summary;
  childrenMap: Map<string, Summary[]>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  level: number;
}

const TreeNode = ({ summary, childrenMap, selectedId, onSelect, level }: TreeNodeProps) => {
  const [expanded, setExpanded] = useState(false);
  const children = childrenMap.get(summary.id) ?? [];
  const hasChildren = children.length > 0;
  const isSelected = selectedId === summary.id;
  const snippet = summary.content.length > 50
    ? summary.content.slice(0, 50) + '...'
    : summary.content;

  return (
    <div>
      <div
        className={`dag-row flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
          isSelected
            ? 'bg-ui/[0.08] ring-1 ring-cp-blue'
            : 'hover:bg-ui/[0.05]'
        }`}
        style={{ paddingLeft: `${level * 16 + 8}px` }}
      >
        {/* Expand/collapse arrow */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) setExpanded(!expanded);
          }}
          className={`w-4 h-4 flex items-center justify-center text-ui/40 flex-shrink-0 mt-0.5 ${
            hasChildren ? 'hover:text-ui/70' : 'invisible'
          }`}
        >
          {hasChildren ? (expanded ? '\u25BC' : '\u25B6') : ''}
        </button>

        {/* Content area - clickable to select */}
        <div
          className="flex-1 min-w-0"
          onClick={() => onSelect(summary.id)}
        >
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center justify-center px-1.5 py-0.5 rounded text-[10px] font-bold text-ui flex-shrink-0 ${getDepthColor(
                summary.depth,
              )}`}
            >
              d{summary.depth}
            </span>
            <span className="text-xs text-ui/70 truncate">{snippet}</span>
          </div>
          <div className="flex items-center gap-3 mt-0.5 text-[10px] text-ui/40">
            <span>{summary.tokenCount} tokens</span>
            <span>{formatTimeRange(summary.earliestAt, summary.latestAt)}</span>
            {summary.depth === 0 && (
              <span>({summary.descendantCount} messages)</span>
            )}
          </div>
        </div>
      </div>

      {/* Children */}
      {expanded && children.length > 0 && (
        <div>
          {children.map((child) => (
            <TreeNode
              key={child.id}
              summary={child}
              childrenMap={childrenMap}
              selectedId={selectedId}
              onSelect={onSelect}
              level={level + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const DagTree = ({ summaries, links, selectedId, onSelect }: DagTreeProps) => {
  const { roots, childrenMap } = useMemo(() => {
    // A link row says: `summaryId` is a condensed summary, `parentIds` are the
    // older summaries it was condensed FROM. So the condensed summary is the
    // tree parent and each source is its child.
    const cMap = new Map<string, Summary[]>();
    const summaryMap = new Map<string, Summary>();
    summaries.forEach((s) => summaryMap.set(s.id, s));

    const isSource = new Set<string>();
    links.forEach((link) => {
      if (!summaryMap.has(link.summaryId)) return;
      link.parentIds.forEach((sourceId) => {
        const source = summaryMap.get(sourceId);
        if (!source) return;
        if (!cMap.has(link.summaryId)) cMap.set(link.summaryId, []);
        cMap.get(link.summaryId)!.push(source);
        isSource.add(sourceId);
      });
    });
    cMap.forEach((kids) => kids.sort((a, b) => a.earliestAt.localeCompare(b.earliestAt)));

    // Roots are summaries nobody was condensed from: highest depth first.
    const rootNodes = summaries
      .filter((s) => !isSource.has(s.id))
      .sort((a, b) => b.depth - a.depth || b.createdAt.localeCompare(a.createdAt));

    return { roots: rootNodes, childrenMap: cMap };
  }, [summaries, links]);

  if (summaries.length === 0) {
    return (
      <div className="p-4 text-center text-ui/40 text-sm">
        No summaries yet. Memory will appear here after compaction runs.
      </div>
    );
  }

  return (
    <div className="py-2 space-y-0.5 overflow-y-auto">
      {roots.map((root) => (
        <TreeNode
          key={root.id}
          summary={root}
          childrenMap={childrenMap}
          selectedId={selectedId}
          onSelect={onSelect}
          level={0}
        />
      ))}
    </div>
  );
};
