// Class-aware tool badge for tool-only assistant turns in regular chat mode
// (V2b). The display CLASS comes from the canonical classifier (@dojo/shared via
// summarizeToolTurn in lib/tool-display); this is the shared visual atom so the
// badge style cannot drift across chat pages (Chat, AgentDetail). Effectful
// actions read slightly more present (text-secondary + gear); retrieval is muted
// (text-tertiary + magnifier), since the data it found stays in wordy mode and
// the agent restates what matters. Bookkeeping-only turns never reach here
// (summarizeToolTurn returns null upstream and the turn is hidden).
import type { ToolTurnSummary } from '../lib/tool-display';

export const ToolBadge = ({ summary }: { summary: ToolTurnSummary }) => {
  const retrieval = summary.primaryClass === 'retrieval';
  const icon = retrieval ? '\u{1F50D}' : '⚙';
  return (
    <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-ui/[0.05] ${retrieval ? 'text-tertiary' : 'text-secondary'} text-[11px] font-sans`}>
      <span className="text-ui/40">{icon}</span>
      <span>{summary.label}</span>
    </div>
  );
};

// One or more tool badges in a left-aligned wrap row. Handles both a single
// tool-only turn (items.length === 1) and a grouped run of adjacent tool-only
// turns. Renders nothing when there is nothing visible (all bookkeeping).
export const ToolBadgeGroup = ({ items }: { items: Array<{ id: string; summary: ToolTurnSummary }> }) => {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 justify-start">
      {items.map((it) => <ToolBadge key={it.id} summary={it.summary} />)}
    </div>
  );
};
