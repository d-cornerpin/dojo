// ════════════════════════════════════════
// The Healer's "lessons from rough tasks" section (K34): the lessons the Dreamer wrote or renewed
// in the last seven days, one line each, with the component it says should change. A report,
// not a limit; nothing is injected into any agent from here.
// ════════════════════════════════════════

import { lessonsTouchedSince } from '../vault/lessons-store.js';
import type { DiagnosticItem } from './diagnostic.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function getLessonItems(now: number = Date.now()): DiagnosticItem[] {
  const lessons = lessonsTouchedSince(now - WEEK_MS, undefined, now);
  if (lessons.length === 0) return [];
  const lines = lessons.map((l) => `- [${l.component}] When: ${l.cue} — ${l.lesson} (${l.renewed_count > 0 ? `seen ${l.renewed_count + 1} times, ` : ''}confidence ${l.confidence})`);
  return [{
    severity: 'info',
    code: 'LESSONS_FROM_ROUGH_TASKS',
    title: `${lessons.length} lesson${lessons.length === 1 ? '' : 's'} from rough tasks this week`,
    detail: `Lessons the Dreamer wrote from tasks that went badly:\n${lines.join('\n')}`,
  }];
}
