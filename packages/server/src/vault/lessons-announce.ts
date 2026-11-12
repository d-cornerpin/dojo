// How the owner hears about a cycle's lessons: one informational owner card and a line in the Dreamer's report.
// Nothing here writes a message or reaches the main agent.

import { ownerConditionCleared, tellOwner } from '../healer/owner-notices.js';
import { lessonsTouchedSince } from './lessons-store.js';

const words = (n: number): string =>
  `${n} lesson${n === 1 ? '' : 's'} from yesterday's rough tasks. They are in the Dreamer's report; the Trainer reads the ones about techniques.`;

export function lessonReportLines(cycleStartedAtMs: number): string[] {
  const n = lessonsTouchedSince(cycleStartedAtMs).length;
  return n === 0 ? [] : [words(n)];
}

/** Tell the owner, once, how many lessons this cycle wrote or renewed. Returns that count. */
export function announceLessons(cycleStartedAtMs: number): number {
  try {
    const n = lessonsTouchedSince(cycleStartedAtMs).length;
    if (n > 0) { ownerConditionCleared('lessons'); tellOwner('lessons', words(n)); }   // each cycle's report is a new telling
    return n;
  } catch {
    return 0;
  }
}
