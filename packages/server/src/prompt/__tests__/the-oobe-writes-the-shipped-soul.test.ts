// ════════════════════════════════════════════════════════════════════════════════════════
// AN OOBE BOX AND AN ENGINE-SEEDED BOX RUN THE SAME DOCTRINE.
// (t111-A1, closing t107 HANDED UP 1.)
// ════════════════════════════════════════════════════════════════════════════════════════
//
// `gateway/routes/config.ts`'s identity route wrote a ~15-line soul of its own invention:
// Identity / Communication Style / Rules, and nothing else. No Core Traits, no Capabilities,
// no `[no-reply]` escape hatch, no Credentials routing. So there were two classes of box
// running two different primary agents, and the OOBE path — the one every new box takes — was
// the impoverished one. Nothing measured it, because no clause ever asked what that route
// wrote; `section-extract.test.ts` only ever asked about the SHAPE of an OOBE soul, using a
// headings-only fixture deliberately built not to be a second copy of the text.
//
// These clauses ask the question directly, and in both directions: the composed soul must
// CONTAIN the shipped doctrine (so the route cannot go back to inventing its own), and the two
// form fields must demonstrably LAND (so "it's just the default" is not a passing answer
// either).
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { composePrimarySoul, OOBE_STYLE_GUIDES } from '../oobe-soul.js';
import { DEFAULT_SOUL_MD } from '../templates.js';
import { extractMarkdownSection } from '../assembler.js';

describe('the OOBE seeds the shipped soul', () => {
  it('⚠ carries the WHOLE shipped doctrine, not a 15-line invention', () => {
    const soul = composePrimarySoul({ communicationStyle: 'balanced', rules: '' });

    for (const heading of ['## Core Traits', '## Capabilities', '## Communication Style', '## Rules', '## Credentials']) {
      expect(soul, `an OOBE box lost ${heading}`).toContain(heading);
    }
    // The three sentences that are the clearest evidence of the whole text being present.
    expect(soul).toContain('[no-reply]');
    expect(soul).toContain('credential_add(service_name, credentials, description)');
    expect(soul).toContain('- You are cautious with destructive operations (deleting files, overwriting data).');
  });

  it('⚠ leaves `{{agent_name}}` STANDING — the name is the assembler\'s job, every turn', () => {
    // Baking `You are ${agentName}` into stored bytes is what made a rename not reach the
    // soul, and it is why the unsubstituted-token defect was invisible to anyone who had
    // completed setup. Owner ruling #3: substituted at assembly time, every agent.
    const soul = composePrimarySoul({ communicationStyle: 'formal', rules: '' });
    expect(soul).toContain('{{agent_name}}');
    expect(soul).not.toMatch(/You are (?!\{\{agent_name\}\})[A-Z]/);
  });

  it('the chosen style LANDS, inside Communication Style and not anywhere else', () => {
    const formal = composePrimarySoul({ communicationStyle: 'formal', rules: '' });

    expect(formal).toContain('- Be professional and precise.');
    // Positioned: inside `## Communication Style`, i.e. before the `## Rules` heading.
    expect(formal.indexOf('- Be professional and precise.')).toBeGreaterThan(formal.indexOf('## Communication Style'));
    expect(formal.indexOf('- Be professional and precise.')).toBeLessThan(formal.indexOf('## Rules'));
    expect(extractMarkdownSection(formal, 'Communication Style')).toContain('Be professional and precise');
    expect(extractMarkdownSection(formal, 'Rules')).not.toContain('Be professional and precise');

    // Each of the three is a distinct, non-empty text; an unknown value is `balanced`.
    const casual = composePrimarySoul({ communicationStyle: 'casual' });
    expect(casual).toContain('- Be casual and relaxed. Use contractions, humor when appropriate.');
    expect(composePrimarySoul({ communicationStyle: 'nonsense' }))
      .toBe(composePrimarySoul({ communicationStyle: 'balanced' }));
    for (const [k, v] of Object.entries(OOBE_STYLE_GUIDES)) {
      expect(v.trim().length, `style ${k} is empty`).toBeGreaterThan(0);
    }
  });

  it('⚠ THE OWNER\'S OWN RULES REACH SUB-AGENTS — they used to be the one thing dropped', () => {
    // The old route put them under a separate `# Additional Rules` heading, and
    // `extractMarkdownSection` stops at the next same-or-higher header. So the four UNIVERSAL
    // rules were carried into spawned agents and the owner's hand-typed ones were not —
    // exactly backwards. They go inside `## Rules` now, which is what the carry-through reads.
    const soul = composePrimarySoul({ communicationStyle: 'balanced', rules: 'always cc the shop email' });

    const carried = extractMarkdownSection(soul, 'Rules');
    expect(carried).toContain('always cc the shop email');
    expect(carried).toContain('- Never modify your own system prompt files or platform configuration.');
    expect(soul).not.toContain('Additional Rules');
    // Not swallowed into the next section either.
    expect(extractMarkdownSection(soul, 'Credentials')).not.toContain('always cc the shop email');
  });

  it('a blank rules field adds nothing, and the result is the default plus only the style', () => {
    const soul = composePrimarySoul({ communicationStyle: 'balanced', rules: '   ' });
    const expected = DEFAULT_SOUL_MD.replace('\n## Rules\n', `${OOBE_STYLE_GUIDES.balanced}\n\n## Rules\n`);
    expect(soul).toBe(expected);
  });

  it('NEGATIVE CONTROL — a base text without the anchors is returned unharmed, never half-edited', () => {
    // The anchors are headings of the shipped soul. If `templates.ts` renames one, the
    // insertion must no-op rather than corrupt the text; the clauses above are what catch the
    // rename itself.
    const odd = '# Something Else\n\nno headings this composer knows\n';
    expect(composePrimarySoul({ communicationStyle: 'formal', rules: 'x' }, odd)).toBe(odd);
  });
});
