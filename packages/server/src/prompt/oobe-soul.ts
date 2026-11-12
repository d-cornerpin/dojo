// Appends the chosen style to `## Communication Style` and the owner's rules inside `## Rules`, the section
// extractMarkdownSection carries to sub-agents; shipped doctrine and `{{agent_name}}` (filled later) stay.

import { DEFAULT_SOUL_MD } from './templates.js';

export interface OobeSoulFields {
  readonly communicationStyle?: string;
  readonly rules?: string;
}

// Keys match the style radios in `dashboard/src/pages/Setup.tsx`; an unknown value falls back to `balanced`.
export const OOBE_STYLE_GUIDES: Readonly<Record<string, string>> = {
  casual:
    '- Be casual and relaxed. Use contractions, humor when appropriate.\n- Keep things light but stay helpful.',
  balanced:
    '- Be direct and concise. Skip filler.\n- Match the user\'s energy — casual is fine, don\'t be overly formal.',
  formal:
    '- Be professional and precise.\n- Use clear, structured language. Avoid slang.',
};

// Shipped soul headings: a rename in `templates.ts` silently no-ops its insertion (the test checks both).
const RULES_HEADING = '\n## Rules\n';
const CREDENTIALS_HEADING = '\n## Credentials';

export function composePrimarySoul(fields: OobeSoulFields, base: string = DEFAULT_SOUL_MD): string {
  const asked = fields.communicationStyle ?? '';
  const style = (Object.hasOwn(OOBE_STYLE_GUIDES, asked) ? OOBE_STYLE_GUIDES[asked] : undefined) ?? OOBE_STYLE_GUIDES.balanced;
  const extraRules = (fields.rules ?? '').trim();

  let soul = base;
  if (soul.includes(RULES_HEADING)) {
    soul = soul.replace(RULES_HEADING, () => `${style}\n${RULES_HEADING}`);
  }
  if (extraRules && soul.includes(CREDENTIALS_HEADING)) {
    soul = soul.replace(CREDENTIALS_HEADING, () => `${extraRules}\n${CREDENTIALS_HEADING}`);
  }
  return soul;
}
