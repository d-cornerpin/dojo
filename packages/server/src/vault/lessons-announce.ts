// ════════════════════════════════════════
// How the owner hears about a cycle's lessons (K34): once, through the existing owner card
// (services/owner-card-frames.ts), and as a line in the Dreamer's cycle report. Nothing here
// writes a message, and nothing here reaches the main agent.
// ════════════════════════════════════════

import { ownerCardFrame } from '../services/owner-card-frames.js';
import { lessonsTouchedSince } from './lessons-store.js';

const words = (n: number): string =>
  `${n} lesson${n === 1 ? '' : 's'} from yesterday's rough tasks. They are in the Dreamer's report; the Trainer reads the ones about techniques.`;

/** The lines the Dreamer's cycle report carries about this cycle's lessons (none when there are none). */
export function lessonReportLines(cycleStartedAtMs: number): string[] {
  const n = lessonsTouchedSince(cycleStartedAtMs).length;
  return n === 0 ? [] : [words(n)];
}

/** Tell the owner, once, how many lessons this cycle wrote or renewed. Returns that count. */
export function announceLessons(cycleStartedAtMs: number): number {
  try {
    const n = lessonsTouchedSince(cycleStartedAtMs).length;
    if (n > 0) ownerCardFrame(words(n), 'warning');
    return n;
  } catch {
    return 0;
  }
}
