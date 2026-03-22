import { useState, useMemo } from 'react';
import type { Summary } from '@dojo/shared';

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
  0: 'bg-blue-500',
  1: 'bg-green-500',
  2: 'bg-orange-500',
};

const getDepthColor = (depth: number): string => {
  return DEPTH_COLORS[depth] ?? 'bg-purple-500';
};

const formatTimeRange = (earliest: string, latest: string): string => {
  const e = new Date(earliest);
  const l = new Date(latest);
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
        className={`flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
          isSelected
            ? 'bg-white/[0.08] ring-1 ring-blue-500'
            : 'hover:bg-white/[0.05]'
        }`}
        style={{ paddingLeft: `${level * 16 + 8}px` }}
      >
        {/* Expand/collapse arrow */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) setExpanded(!expanded);
          }}
          className={`w-4 h-4 flex items-center justify-center white/40 flex-shrink-0 mt-0.5 ${
            hasChildren ? 'hover:white/70' : 'invisible'
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
              className={`inline-flex items-center justify-center px-1.5 py-0.5 rounded text-[10px] font-bold text-white flex-shrink-0 ${getDepthColor(
                summary.depth,
              )}`}
            >
              d{summary.depth}
            </span>
            <span className="text-xs white/70 truncate">{snippet}</span>
          </div>
          <div className="flex items-center gap-3 mt-0.5 text-[10px] white/40">
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
    // Build a map of summaryId -> parentIds
    const parentMap = new Map<string, string[]>();
    links.forEach((link) => {
      parentMap.set(link.summaryId, link.parentIds);
    });

    // Build children map: parentId -> children summaries
    const cMap = new Map<string, Summary[]>();
    const summaryMap = new Map<string, Summary>();
    summaries.forEach((s) => summaryMap.set(s.id, s));

    // For each summary, if it has parents, add it as a child of each parent
    const hasParent = new Set<string>();
    links.forEach((link) => {
      link.parentIds.forEach((parentId) => {
        if (!cMap.has(parentId)) {
          cMap.set(parentId, []);
        }
        const child = summaryMap.get(link.summaryId);
        if (child) {
          cMap.get(parentId)!.push(child);
          hasParent.add(link.summaryId);
        }
      });
    });

    // Root nodes are those with no parents (highest depth or unlinked)
    const rootNodes = summaries
      .filter((s) => !hasParent.has(s.id))
      .sort((a, b) => b.depth - a.depth || b.createdAt.localeCompare(a.createdAt));

    return { roots: rootNodes, childrenMap: cMap };
  }, [summaries, links]);

  if (summaries.length === 0) {
    return (
      <div className="p-4 text-center white/40 text-sm">
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
