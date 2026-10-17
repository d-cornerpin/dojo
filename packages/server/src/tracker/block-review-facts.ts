// ════════════════════════════════════════════════════════════════════════════════════════
// The PM's block review: the payload line for one UNVALIDATED_BLOCK, with the platform's own
// recent tool and connection facts attached (t190, C3; owner ruling: ALWAYS shown).
//
// WHY. A worker marks a task blocked and says why in its own words; the review used to hold
// those words and the goal and nothing else, so a block citing a "broken" tool was confirmed
// in minutes without anyone checking that the tool had been working. The facts exist: the
// per-tool outcome record (`agent/v2/tool-outcomes.ts`) and the connection state the live
// status line already reads. They are GATHERED BY THE ENGINE and put in front of the PM; the
// PM gets no new tool and queries nothing.
//
// WHICH TOOLS. The block's own text (title, goal, reason) is searched for the assignee's
// recorded tool names, and any tool whose last outcome is a failure is included whether or not
// the text names it (a block that only says "I cannot do this" still shows the open failure).
// The connection lines (state, last successful use, open failure) are always shown.
// ════════════════════════════════════════════════════════════════════════════════════════

import { isOpenFailure, readToolOutcomes, type ToolOutcome } from '../agent/v2/tool-outcomes.js';
import { integrationFactLines } from '../memory/integration-status-lane.js';
import { recordedInstant } from '../memory/message-stamp.js';

export interface BlockReviewInput {
  taskId: string;
  title: string;
  agentName: string;
  assigneeId: string | null;
  goal: string | null;
  priority: string;
  revertCount: number;
  blockReason: string;
}

/** An error text as one short line: a display clip, the stored text is whole. */
const oneLine = (s: string): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}...` : flat;
};

function toolFact(o: ToolOutcome): string {
  const ok = o.lastOkAt ? `last SUCCEEDED ${recordedInstant(o.lastOkAt)}` : 'no success on record';
  const failed = o.lastFailAt
    ? `; last FAILED ${recordedInstant(o.lastFailAt)}${o.lastError ? ` ("${oneLine(o.lastError)}")` : ''}`
    : '';
  const now = isOpenFailure(o)
    ? `most recent call FAILED (${o.consecutiveFailures} in a row)`
    : 'most recent call SUCCEEDED';
  return `    • ${o.toolName}: ${ok}${failed}; ${now}.`;
}

/** The facts section for one assignee, given the text of the block it will be read against. */
export async function platformFactsFor(assigneeId: string | null, blockText: string): Promise<string> {
  const head = '  PLATFORM FACTS (recorded by the engine, not by the agent; read the block reason against them):';
  if (!assigneeId) return `${head}\n    • No assignee, so there is no recorded tool outcome to show.`;
  const text = blockText.toLowerCase();
  const involved = readToolOutcomes(assigneeId).filter((o) =>
    isOpenFailure(o) || text.includes(o.toolName.replace(/^user_/, '').toLowerCase()));
  const lines = involved.length > 0
    ? involved.map(toolFact)
    : ['    • No recorded outcome matches a tool named in this block, and no tool has an open failure.'];
  const connections = (await integrationFactLines(assigneeId)).map((l) => `    ${l}`);
  return [head, ...lines, ...connections].join('\n');
}

/** The whole UNVALIDATED_BLOCK issue text, facts included. */
export async function unvalidatedBlockIssueText(b: BlockReviewInput): Promise<string> {
  const facts = await platformFactsFor(b.assigneeId, `${b.title}\n${b.goal ?? ''}\n${b.blockReason}`);
  return (
    `UNVALIDATED_BLOCK: "${b.title}" (${b.taskId.slice(0, 8)}) marked blocked by ${b.agentName}, awaiting validation.\n` +
    `  Goal: ${b.goal ?? '(no goal recorded)'}\n` +
    `  Block reason: ${b.blockReason}\n` +
    `${facts}\n` +
    `  If the block reason cites a failing tool or connection and the facts above contradict it (the tool's most recent call SUCCEEDED, the connection is CONNECTED), it is not a real block: reject it.\n` +
    `  Priority=${b.priority}, revert_count=${b.revertCount}.\n` +
    `  Real block (genuine external obstacle, no workaround) -> work_validate(action="validate", kind="blocked", task_id="${b.taskId}", valid=true). ` +
    `Not really blocked (agent hasn't asked the user, or has a workaround they haven't tried) -> work_validate(action="validate", kind="blocked", task_id="${b.taskId}", valid=false, reject_reason="...").`
  );
}
