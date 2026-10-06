// ════════════════════════════════════════════════════════════════════════════════════════
// THE OOBE'S SOUL IS THE SHIPPED SOUL, PLUS THE TWO FIELDS THE FORM COLLECTS.
// (t111-A1, closing t107 HANDED UP 1; owner ruling #11's soul half.)
// ════════════════════════════════════════════════════════════════════════════════════════
//
// `gateway/routes/config.ts`'s identity-generation route used to compose its own ~15-line
// `# Identity` soul and write it to `~/.dojo/prompts/SOUL.md`. It was neither
// `DEFAULT_SOUL_MD` nor any shipped template — a THIRD source of the primary's identity, on
// the one path every new box takes. What that cost, measured:
//
//   * **The doctrine was missing.** An OOBE box's primary ran on Identity / Communication
//     Style / Rules and nothing else: no Core Traits, no Capabilities, no `[no-reply]` escape
//     hatch, no Credentials routing. An engine-seeded box ran on the full template. Two
//     classes of box, two different agents, and the OOBE path is the common one.
//   * **`You are ${agentName}` was baked into stored bytes.** The agent's name belongs to the
//     `agents` row, and `{{agent_name}}` is substituted at assembly time for every agent every
//     turn (owner ruling #3). Baking it in is what made a rename not reach the soul — and it
//     is why the unsubstituted-`{{agent_name}}` defect was invisible to anyone who had
//     completed setup, since their file had no token left in it to go wrong.
//   * **The owner's own rules did not reach sub-agents.** The route put them under a separate
//     `# Additional Rules` heading, and `extractMarkdownSection` stops at the next
//     same-or-higher header — so the four UNIVERSAL rules were carried to spawned agents and
//     the owner's hand-typed ones were the one thing dropped. Exactly backwards.
//
// So the route composes nothing now. This module substitutes the two fields the form really
// collects into the shipped text, and the result goes to disk through `writeSoulFile`, the one
// soul write door.
//
// ── WHY APPEND AND NOT REPLACE ────────────────────────────────────────────────────────
// The style guide is ADDED to `## Communication Style` rather than replacing it, and the
// owner's extra rules are ADDED inside `## Rules`. Replacing either would throw away shipped
// doctrine the owner never asked to lose — the `[no-reply]` contract lives in the first of
// those sections, and the four universal rules in the second.
// ════════════════════════════════════════════════════════════════════════════════════════

import { DEFAULT_SOUL_MD } from './templates.js';

/** The fields the OOBE's identity form collects about the AGENT (not about the person). */
export interface OobeSoulFields {
  /** `casual` | `balanced` | `formal`; anything unrecognised falls back to `balanced`. */
  readonly communicationStyle?: string;
  /** Free text the owner typed as standing rules for their agents. */
  readonly rules?: string;
}

/**
 * The three styles the form offers. Keyed exactly as the dashboard's radio values, so an
 * unrecognised value is a typo on one side or the other and lands on `balanced` rather than
 * writing an empty section.
 */
export const OOBE_STYLE_GUIDES: Readonly<Record<string, string>> = {
  casual:
    '- Be casual and relaxed. Use contractions, humor when appropriate.\n- Keep things light but stay helpful.',
  balanced:
    '- Be direct and concise. Skip filler.\n- Match the user\'s energy — casual is fine, don\'t be overly formal.',
  formal:
    '- Be professional and precise.\n- Use clear, structured language. Avoid slang.',
};

/**
 * The anchors this composer inserts at. They are HEADINGS OF THE SHIPPED SOUL, so renaming one
 * in `templates.ts` without renaming it here makes the insertion a silent no-op — which is why
 * `__tests__/the-oobe-writes-the-shipped-soul.test.ts` asserts both insertions LANDED rather
 * than asserting this function was called.
 */
const RULES_HEADING = '\n## Rules\n';
const CREDENTIALS_HEADING = '\n## Credentials';

/**
 * The soul an OOBE box stores: the shipped default with the chosen style appended to its
 * Communication Style section and the owner's rules appended inside its Rules section.
 *
 * `{{agent_name}}` is left STANDING on purpose — the assembler fills it per agent per turn.
 *
 * @param base the shipped soul to seed from; defaults to `DEFAULT_SOUL_MD`. The route passes
 *        the fallback its soul door reports, so the two can never disagree about which text
 *        the primary seeds from.
 */
export function composePrimarySoul(fields: OobeSoulFields, base: string = DEFAULT_SOUL_MD): string {
  const style = OOBE_STYLE_GUIDES[fields.communicationStyle ?? ''] ?? OOBE_STYLE_GUIDES.balanced;
  const extraRules = (fields.rules ?? '').trim();

  let soul = base;
  if (soul.includes(RULES_HEADING)) {
    soul = soul.replace(RULES_HEADING, `${style}\n${RULES_HEADING}`);
  }
  if (extraRules && soul.includes(CREDENTIALS_HEADING)) {
    soul = soul.replace(CREDENTIALS_HEADING, `${extraRules}\n${CREDENTIALS_HEADING}`);
  }
  return soul;
}
