// Class-aware tool badge for tool-only assistant turns in regular chat mode
// (V2b). The display CLASS comes from the canonical classifier (@dojo/shared via
// summarizeToolTurn in lib/tool-display); this is the shared visual atom so the
// badge style cannot drift across chat pages (Chat, AgentDetail). Effectful
// actions read slightly more present (text-secondary + gear); retrieval is muted
// (text-tertiary + magnifier), since the data it found stays in wordy mode and
// the agent restates what matters. Bookkeeping-only turns never reach here
// (summarizeToolTurn returns null upstream and the turn is hidden).
import { useState } from 'react';
import type { ToolTurnSummary } from '../lib/tool-display';
import { ToolCallCard, ToolResultBlock } from './ToolCallBlock';

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

// One raw tool call for the chip-tool collapsed look used in the dojo3 chat. The
// chip itself reads as a small mono UPPERCASE pill (styled under .dojo3-stage as
// .chip-tool); clicking it expands the canonical ToolCallCard (args) plus an
// optional ToolResultBlock so the detail view is never lost. Outside the dojo3
// stage the chip-tool class is unstyled, so AgentDetail (which never passes
// `chips`) keeps the summary-badge look untouched.
export interface ToolChipData {
  key: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

const ToolChip = ({ chip }: { chip: ToolChipData }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        className="chip-tool"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {chip.name}
      </button>
      {open && (
        <div className="chip-tool__detail w-full max-w-[420px]">
          <ToolCallCard name={chip.name} input={chip.input} />
          {chip.result !== undefined && (
            <ToolResultBlock toolUseId="" content={chip.result} isError={!!chip.isError} />
          )}
        </div>
      )}
    </div>
  );
};

// One or more tool badges in a left-aligned wrap row. Handles both a single
// tool-only turn (items.length === 1) and a grouped run of adjacent tool-only
// turns. Renders nothing when there is nothing visible (all bookkeeping).
//
// When `chips` is supplied (dojo3 chat), each underlying tool renders as an
// expandable chip-tool pill instead of the summarized class badge, matching the
// prototype anatomy while keeping the args/results detail one click away. Other
// callers (AgentDetail) pass only `items` and get the unchanged badge row.
export const ToolBadgeGroup = ({
  items,
  chips,
}: {
  items: Array<{ id: string; summary: ToolTurnSummary }>;
  chips?: ToolChipData[];
}) => {
  if (chips && chips.length > 0) {
    return (
      <div className="flex flex-wrap items-start gap-1.5 justify-start">
        {chips.map((c) => <ToolChip key={c.key} chip={c} />)}
      </div>
    );
  }
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 justify-start">
      {items.map((it) => <ToolBadge key={it.id} summary={it.summary} />)}
    </div>
  );
};
