// ════════════════════════════════════════
// The Healer report's harness sections, in one place so the diagnostic registers them with a
// single call: recurring tool errors (K37), the standing instruction's cost (K36), the Dreamer's lessons (K34). Each is a
// report, not a limit.
// ════════════════════════════════════════

import type { DiagnosticItem } from './diagnostic.js';
import { getLessonItems } from './lessons-section.js';
import { getPromptCostItems } from './prompt-cost-section.js';
import { getRecurringToolErrors } from './recurring-tool-errors.js';

export function getHarnessSections(): DiagnosticItem[] {
  return [...getRecurringToolErrors(), ...getPromptCostItems(), ...getLessonItems()];
}
