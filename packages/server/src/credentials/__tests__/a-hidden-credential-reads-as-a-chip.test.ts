// ════════════════════════════════════════════════════════════════════════════════════════
// THE OWNER WAS SHOWN `<redacted-credential:c1>` AS BODY TEXT (BACKLOG, redaction work).
//
// ── THE DEFECT ──
// The engine is right to substitute: `credentials/secret-values.ts` replaces a value the
// platform is holding with `<redacted-credential:c1>` (or the bare `<redacted-credential>` for a
// declared field with no in-process handle), and the round-8 incident is precisely what happens
// when a real secret rides in chat instead. What was wrong is what the dashboard DREW — the
// literal token, angle brackets and all, as body text. The owner reads gibberish exactly where a
// value should be, and nothing tells him the value exists, is safe, or where to look.
//
// ── WHY THIS TEST LIVES IN THE SERVER PACKAGE ──
// `packages/dashboard` has no test runner and wiring one is outside this change (BACKLOG names it
// as its own item). The precedent is `__tests__/dashboard-dates.test.ts` and `marker-ownership`:
// a cross-package rule lives here so that it RUNS. A guard the suite does not run is a sentence
// in a report.
//
// ── THE CLAUSE THAT MATTERS MOST IS THE DRIFT CLAUSE ──
// The renderer's matcher is a SECOND COPY of the engine's private `PLACEHOLDER_RE`, because that
// regex belongs to the leak guard and widening a security module's surface to share it is not
// worth it. So the copy is not trusted: the clauses below drive the REAL redactor
// (`redactHandedCredentials`) and feed its actual output to the renderer's splitter. If the engine
// ever changes the shape it writes, this goes RED instead of the owner quietly getting gibberish
// back.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  noteHandedCredentialValues,
  forgetHandedCredentialValues,
  redactHandedCredentials,
  REDACTED_CREDENTIAL,
  CREDENTIAL_STALE_PLACEHOLDER,
} from '../secret-values.js';

import {
  splitCredentialPlaceholders,
  hasCredentialPlaceholder,
  credentialChipTitle,
  CREDENTIAL_CHIP_LABEL,
  CREDENTIAL_CHIP_HINT,
} from '../../../../dashboard/src/lib/credential-placeholder';

const AGENT = 'agent-under-test';
const SECRET = 'hunter2-hunter2-hunter2';

const DASHBOARD = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '../../../../dashboard/src',
);

beforeEach(() => { forgetHandedCredentialValues(); });
afterEach(() => { forgetHandedCredentialValues(); });

/** Only the ordinary text a reader would still see. */
const textOf = (s: string): string =>
  splitCredentialPlaceholders(s).filter((x) => x.kind === 'text').map((x) => (x as { text: string }).text).join('');

describe('what the engine writes, the renderer recognises — driven through the REAL redactor', () => {
  it('a redacted value becomes exactly one chip, and the sentence around it survives', () => {
    noteHandedCredentialValues(AGENT, [SECRET]);
    const redacted = redactHandedCredentials(AGENT, `The gate code is ${SECRET} — use it tonight.`);

    // Premise check: the engine really did substitute, so this test is about the real shape.
    expect(redacted, 'the engine substituted').not.toContain(SECRET);
    expect(hasCredentialPlaceholder(redacted), 'the renderer sees a placeholder').toBe(true);

    const segments = splitCredentialPlaceholders(redacted);
    const chips = segments.filter((s) => s.kind === 'credential');
    expect(chips.length, 'one value hidden, one chip drawn').toBe(1);

    // The prose is untouched — the splitter replaces the token and rewrites nothing else.
    expect(textOf(redacted)).toBe('The gate code is  — use it tonight.');
    // …and the secret is nowhere in what gets drawn.
    expect(JSON.stringify(segments)).not.toContain(SECRET);
  });

  it('TWO different values in one message become two chips with different handles', () => {
    const other = 'correct-horse-battery-staple';
    noteHandedCredentialValues(AGENT, [SECRET, other]);
    const redacted = redactHandedCredentials(AGENT, `first ${SECRET} then ${other}`);

    const chips = splitCredentialPlaceholders(redacted)
      .filter((s): s is { kind: 'credential'; tag: string | null } => s.kind === 'credential');
    expect(chips.length, 'two hidden values, two chips').toBe(2);
    expect(chips[0].tag, 'a tagged placeholder carries its handle').toBeTruthy();
    expect(chips[1].tag).toBeTruthy();
    expect(chips[0].tag, 'different values get different handles').not.toBe(chips[1].tag);
  });

  it('the BARE form (a declared field, no handle) is a chip too, with no handle', () => {
    const segments = splitCredentialPlaceholders(`stored: ${REDACTED_CREDENTIAL}`);
    const chips = segments.filter((s): s is { kind: 'credential'; tag: string | null } => s.kind === 'credential');
    expect(chips.length, 'the untagged form must not reach the owner as a token either').toBe(1);
    expect(chips[0].tag, 'there is no handle to name').toBeNull();
    expect(credentialChipTitle(null), 'and the tooltip still says where it lives')
      .toBe(CREDENTIAL_CHIP_HINT);
  });
});

describe('the rule refuses what the engine would never write', () => {
  it('leaves ordinary prose completely alone', () => {
    for (const plain of [
      'no secrets here',
      'the credential is in the vault',
      'angle < brackets > in prose',
      '',
    ]) {
      expect(hasCredentialPlaceholder(plain), `plain text must not match: ${plain}`).toBe(false);
      expect(textOf(plain), 'and passes through byte-for-byte').toBe(plain);
    }
  });

  it('refuses near-misses, so a sentence ABOUT the mechanism is not drawn as a chip', () => {
    for (const nearMiss of [
      '<redacted-credentials>',          // plural — not the token
      '<redacted-credential:C1>',        // uppercase handle — the engine writes [a-z0-9]
      '<redacted-credential:>',          // empty handle
      '<redacted_credential>',           // underscore
      'redacted-credential:c1',          // no brackets
    ]) {
      expect(
        hasCredentialPlaceholder(nearMiss),
        `a near-miss must stay literal text, not become a chip: ${nearMiss}`,
      ).toBe(false);
    }
  });

  it('leaves the STALE placeholder as the English sentence it was designed to be', () => {
    // Its own header says naming the fetch tool is the point; substituting it would remove
    // information. It is deliberately NOT part of this change.
    expect(hasCredentialPlaceholder(CREDENTIAL_STALE_PLACEHOLDER)).toBe(false);
    expect(textOf(CREDENTIAL_STALE_PLACEHOLDER)).toBe(CREDENTIAL_STALE_PLACEHOLDER);
  });
});

describe('the renderer actually uses the rule — the token can no longer reach the page', () => {
  it('Markdown.tsx draws the chip through the shared decision, not its own regex', () => {
    const md = fs.readFileSync(path.join(DASHBOARD, 'components/Markdown.tsx'), 'utf8');
    expect(md, 'the renderer imports the decidable rule').toContain('credential-placeholder');
    expect(md, 'and draws the chip label from it').toContain('CREDENTIAL_CHIP_LABEL');
    // The renderer must not grow its own copy of the pattern — that is the drift this avoids.
    expect(
      /<redacted-credential/.test(md),
      'the literal token must not be hand-written in the renderer; the rule owns the pattern',
    ).toBe(false);

    // ── THE WIRING, AND THE HONEST BOUND ON HOW IT IS HELD ──────────────────────────────
    // `packages/dashboard` has no test runner (its own BACKLOG item), so there is no way from
    // here to RENDER this component and read the DOM. The decision is behaviourally driven
    // above; the WIRING is held by these source clauses, which is weaker and is said so out
    // loud rather than left implied. They exist because a mutation run proved the earlier
    // import-only clause survived disabling the chip entirely — the original bug restored, with
    // the test still green. These pin the two things that mutant needed:
    //   (a) the splitter is actually CALLED on the inline path, and
    //   (b) a credential segment actually DRAWS the chip component.
    expect(md, 'the splitter is called, not merely imported').toMatch(/splitCredentialPlaceholders\s*\(/);
    expect(md, 'a credential segment draws the chip').toMatch(/kind === 'credential'[\s\S]{0,120}<CredentialChip/);
    // …and the formatting pass must NOT be the thing deciding, or (a) becomes decorative.
    expect(
      md.indexOf('splitCredentialPlaceholders('),
      'the split happens before the formatting pass it protects',
    ).toBeLessThan(md.indexOf('function processInlineFormatting'));
  });

  it('the chip names where the value is, and it is not the Vault', () => {
    // The BACKLOG line says "Vault tab" as shorthand; the Vault is long-term MEMORY and a
    // credential is not in it. Pointing the owner at the wrong tab to hunt for a secret is worse
    // than saying nothing, so the hint names the Credentials tab that actually holds it.
    expect(CREDENTIAL_CHIP_HINT).toContain('Credentials');
    expect(CREDENTIAL_CHIP_LABEL.length, 'the chip says something').toBeGreaterThan(0);
    const memory = fs.readFileSync(path.join(DASHBOARD, 'pages/Memory.tsx'), 'utf8');
    expect(memory, 'the destination the chip names really exists').toContain("'credentials'");
  });
});
