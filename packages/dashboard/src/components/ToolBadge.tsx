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
  // Pill text. Defaults to `name`; the generic runner tools (exec,
  // applescript_run) carry a payload-derived label here (e.g. `mv`, `finder`)
  // via deriveChipLabel. The expanded detail always uses the true `name`.
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
        {chipLabel(chip)}
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

// A run of chips sharing the SAME pill label in one chip row (the owner
// screenshotted 14 identical PLAUD_GET_SUMMARY pills; the same now applies to a
// repeated exec base command like `mv`). Collapse them to ONE chip-tool pill
// carrying a small corner count badge (the label + e.g. 14).
// Clicking the collapsed chip expands it inline into the individual member
// chips, each of which then behaves exactly as a standalone ToolChip (click one
// to open its args/result detail). Only used for members.length >= 2; a lone
// call renders as a plain ToolChip. The pill look is the same .chip-tool; the
// badge is the dojo3 count idiom (.kcol__count) parked on the corner.
const GroupedToolChip = ({ name, members }: { name: string; members: ToolChipData[] }) => {
  const [expanded, setExpanded] = useState(false);
  // Expanded: emit the individual chips so they flow inline in the parent chip
  // row exactly like ungrouped chips, each with its own expand-to-detail.
  if (expanded) {
    return <>{members.map((c) => <ToolChip key={c.key} chip={c} />)}</>;
  }
  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        className="chip-tool chip-tool--group"
        aria-expanded={false}
        aria-label={`${name}, ${members.length} calls (expand)`}
        onClick={() => setExpanded(true)}
      >
        {name}
        <span className="chip-tool__count" aria-hidden="true">{members.length}</span>
      </button>
    </div>
  );
};

// Collapse same-LABEL chips within a row into groups, first-appearance order.
// Grouping keys on the displayed label, not the raw tool name, so a run of the
// same exec command (`mv`, `mv`, `mv`) still collapses to one "MV x3" pill while
// three different commands (`mv`, `rm`, `ls`) stay distinct. Non-runner tools
// group exactly as before (label defaults to name). A label that appears once
// stays a group of one (rendered as a plain ToolChip). [A, B, A] -> [A(2), B(1)].
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
    // Collapse repeated same-named calls into one counted chip; a single call
    // stays a plain ToolChip. Group key is the first member's stable key.
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
