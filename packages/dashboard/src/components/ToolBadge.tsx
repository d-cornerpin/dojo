// Class-aware tool badge for tool-only assistant turns. The class comes from
// the canonical classifier (lib/tool-display) and this shared atom keeps the
// style from drifting across chat pages. Effectful turns read a touch more
// present, retrieval is muted, and bookkeeping turns never reach here.
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

// One raw tool call as a mono pill (.chip-tool, styled only under the dojo3
// stage); clicking expands the canonical args card plus the result block.
export interface ToolChipData {
  key: string;
  name: string;
  // Pill text; defaults to `name`. Generic runner tools (exec,
  // applescript_run) carry a payload-derived label here via deriveChipLabel.
  label?: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

const chipLabel = (c: ToolChipData) => c.label ?? c.name;

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
        {chipLabel(chip)}{chip.isError ? ' (failed)' : ''}
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

// A run of chips sharing one pill label collapses to one chip-tool pill with
// a corner count badge; clicking expands it inline into standalone ToolChips.
const GroupedToolChip = ({ name, members }: { name: string; members: ToolChipData[] }) => {
  const [expanded, setExpanded] = useState(false);
  if (expanded) {
    return <>{members.map((c) => <ToolChip key={c.key} chip={c} />)}</>;
  }
  const failed = members.filter((c) => c.isError).length;
  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        className="chip-tool chip-tool--group"
        aria-expanded={false}
        aria-label={`${name}, ${members.length} calls${failed > 0 ? `, ${failed} failed` : ''} (expand)`}
        onClick={() => setExpanded(true)}
      >
        {name}{failed > 0 ? ` (${failed} failed)` : ''}
        <span className="chip-tool__count" aria-hidden="true">{members.length}</span>
      </button>
    </div>
  );
};

// Collapse same-LABEL chips within a row into groups, in first-appearance
// order. Keying on the displayed label (not the raw name) collapses repeated
// exec commands to one pill while different commands stay distinct.
// A label seen once stays a group of one (rendered as a plain ToolChip).
function groupChipsByLabel(chips: ToolChipData[]): Array<{ name: string; members: ToolChipData[] }> {
  const order: string[] = [];
  const byLabel = new Map<string, ToolChipData[]>();
  for (const c of chips) {
    const label = chipLabel(c);
    const existing = byLabel.get(label);
    if (existing) {
      existing.push(c);
    } else {
      byLabel.set(label, [c]);
      order.push(label);
    }
  }
  return order.map((name) => ({ name, members: byLabel.get(name)! }));
}

// One or more tool badges in a left-aligned wrap row; nothing when every turn
// was bookkeeping. With `chips` (dojo3 chat) each call becomes an expandable
// chip pill; other callers pass only `items` and get the unchanged badge row.
export const ToolBadgeGroup = ({
  items,
  chips,
}: {
  items: Array<{ id: string; summary: ToolTurnSummary }>;
  chips?: ToolChipData[];
}) => {
  if (chips && chips.length > 0) {
    // Groups repeat by label; the React key is the first member's stable key.
    const groups = groupChipsByLabel(chips);
    return (
      <div className="flex flex-wrap items-start gap-1.5 justify-start">
        {groups.map((g) =>
          g.members.length > 1 ? (
            <GroupedToolChip key={g.members[0].key} name={g.name} members={g.members} />
          ) : (
            <ToolChip key={g.members[0].key} chip={g.members[0]} />
          ),
        )}
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
