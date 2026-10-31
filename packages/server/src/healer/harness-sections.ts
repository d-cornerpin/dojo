// ════════════════════════════════════════
// The Healer report's harness sections, in one place so the diagnostic registers them with a
// single call: recurring tool errors (K37), the standing instruction's cost (K36), the Dreamer's lessons (K34). Each is a
// report, not a limit.
//
// NO CHAR CAP HERE, ON PURPOSE. `capItemsByText` drops a whole item, so a long list would make a whole
// section vanish without a word. Each section lists every row and says where the full data lives;
// the one size discipline is the Healer's own context budget (`buildHealerCycleMessage` in
// healer-agent.ts, derived from the Healer model's window), which elides with a visible marker.
// ════════════════════════════════════════

import type { DiagnosticItem } from './diagnostic.js';
import { collect } from './collect-guard.js';
import { getLessonItems } from './lessons-section.js';
import { getPromptCostItems } from './prompt-cost-section.js';
import { getRecurringToolErrors } from './recurring-tool-errors.js';

export function getHarnessSections(): DiagnosticItem[] {
  return [
    ...collect('recurring tool errors', getRecurringToolErrors),
    ...collect('prompt cost', getPromptCostItems),
    ...collect('lessons', getLessonItems),
  ];
}
