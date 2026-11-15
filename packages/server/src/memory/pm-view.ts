// The project manager's view, chosen by what the turn is about: its pinned memories, a short tail of its
// conversation, the file of the task an agent's message is about, and the present turn (its trigger and its own
// rows). Review reports and proof reads of other turns never come back: the board records what they decided.
import type { Message } from '@dojo/shared';
import { isPMAgent } from '../config/platform.js';
import { pinnedContextSection } from '../vault/retrieval.js';
import { turnContext as liveTurnContext } from '../agent/turn-context.js';
import { patienceBoundMs } from '../tracker/assignee-patience.js';
import { answeredThread, tiedTask } from '../work/done/who-decides.js';
import { workFile } from '../work/project-file.js';
import type { PromptTurnContext } from '../prompt/assembler.js';
import { boardAgentRows } from './store.js';
import { contextOverflowSince } from './compaction.js';

/** The PM's memory is its board: its view is chosen by what the turn is about, and it keeps no summaries. */
export const keepsNoSummaries = (agentId: string): boolean => isPMAgent(agentId);

export interface PMViewParts { pinned: string; tail: Message[]; file: string; present: Message[]; room: number }

/** The parts in trim priority, kept longest first: the present turn, the file, the pinned memories, the tail. */
export function pmViewParts(agentId: string, turnContext: PromptTurnContext | undefined, contentBudget: number, block: number): PMViewParts {
  const live = liveTurnContext(agentId);
  const { tail, present } = boardAgentRows(agentId, block, live?.turnNumber ?? null, turnContext?.engineEventKeepFullId ?? live?.triggerMessageId ?? null);
  // For one patience bound after a forced pass the view fits half its budget, so the retry assembles a smaller one.
  const room = contextOverflowSince(agentId, Date.now() - patienceBoundMs(agentId)) ? Math.floor(contentBudget / 2) : contentBudget;
  const task = turnContext?.counterparty?.kind === 'agent' ? tiedTask(agentId, answeredThread(agentId) ?? turnContext.counterparty.threadId) : null;
  const file = task ? `The task this message is about, [${task}]:${workFile(task, Math.floor(room / 4))}` : '';
  return { pinned: pinnedContextSection(agentId).section, tail, file, present, room };
}
