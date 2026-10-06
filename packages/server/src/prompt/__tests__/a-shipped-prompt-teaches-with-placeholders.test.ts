// ════════════════════════════════════════════════════════════════════════════════════════
// A SHIPPED PROMPT TEACHES WITH PLACEHOLDERS, NOT WITH PEOPLE — OWNER RULING 2026-10-05 #5.
//
// The decisions batch asked it as a question — *"Example names in shipped prompts (fictional
// names stay, or anonymized placeholders?)"* — and the ruling is PLACEHOLDERS. The names were
// adjudicated FICTIONAL on 2026-09-26, so this was never a leak; what the earlier adjudication
// deliberately left open is the question this ruling closes: *"whether a prompt should teach by
// example agent NAMES at all"*. It should not. A model handed `[USER · Sam]` as the shape of a
// party tag has been given an invented person to reason about, and on a box where the invented
// word happens to be a real agent or a real contact it is worse than invented.
//
// ── WHAT THIS SCANS, AND WHY IT IS ANCHORED RATHER THAN WHOLESALE ──
// The whole shipped prompt corpus is tens of thousands of words of English, and English is full
// of capitalised words. So the clause does not sweep prose: it walks the EXAMPLE SLOTS — the
// lines whose entire job is to show a shape — and holds those to the rule that a party, a
// contact or an agent appears there as a ROLE PLACEHOLDER. Each anchor is a regex over one
// shipped surface, and a surface whose anchor matches NOTHING fails loudly rather than passing
// vacuously, which is the trap an anchored scan would otherwise walk into.
//
// ── THE NAME SHAPE, AND THE ONE DECLARED VOCABULARY ──
// A person-name-shaped token is `Capitalised` mid-sentence. Sentence-initial words are exempt by
// POSITION (an example that begins a sentence tells you nothing about who), ALL-CAPS is exempt
// by shape, and five words that legitimately appear mid-line are declared below with the reason
// each is not a person. That list is deliberately tiny and must be ADDED TO by hand: a new
// capitalised word in an example slot reds here and someone has to say which kind of word it is.
// That is the direction a blocklist of retired names could never cover — and a blocklist is also
// exactly what must not be written down, because a name list in a public repository is the leak
// `deploy/checks/check-no-personal-names.mjs` exists to prevent.
//
// ── WHAT THIS IS NOT ──
// Not the names gate. That gate matches the LIVE roster and the owner's recorded name at check
// time and writes nothing down; it found these lines only as a COLLISION and carried them on a
// dated allowlist. The allowlist entry is retired in the gate-side half of this change, and this
// clause is what stands in its place: the gate answers "is this a real person", this answers "is
// this a person at all".
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');

/**
 * THE EXAMPLE SLOTS, each named by what it teaches.
 *
 * `anchor` selects the lines; `what` is what a reader should understand it covers. A new shipped
 * prompt that teaches a party shape belongs here — that is a deliberate, visible addition, and
 * the census clause below reports the corpus size so a silent shrink is visible too.
 */
const EXAMPLE_SLOTS: ReadonlyArray<{ file: string; anchor: RegExp; what: string; roles: number }> = [
  {
    file: 'templates/DREAMER-SOUL.md',
    anchor: /^\| `(?:fact|preference|relationship|decision|event|note|procedure)` \|/,
    what: 'the Dreamer\'s per-type format table — its Example column is a shape, not a story',
    roles: 4,
  },
  {
    file: 'templates/DREAMER-SOUL.md',
    anchor: /Person-as-entity observations/,
    what: 'the contact_remember routing bullet, which shows three person-fact shapes',
    roles: 4,
  },
  {
    file: 'packages/server/src/vault/maintenance.ts',
    anchor: /^Conversation attribution:/,
    what: 'the Dreamer cycle message\'s party-tag examples — the line the 2026-09-26 audit found',
    roles: 6,
  },
  {
    file: 'packages/server/src/memory/summarize.ts',
    anchor: /^\[USER · <name>\] = an inbound message/,
    what: 'the compaction prompt\'s INPUT FORMAT party tags',
    roles: 2,
  },
  {
    file: 'packages/server/src/memory/summarize.ts',
    anchor: /MUST state which party\/conversation it belongs to/,
    what: 'the compaction prompt\'s attribution rule and its two worked examples',
    roles: 1,
  },
];

/**
 * Mid-line capitalised words that name NOBODY, each with the reason it is here. Short on
 * purpose: this is the list a reviewer reads, and a long one would stop being read.
 */
const NOT_A_PERSON = new Map<string, string>([
  ['Tunnel', 'a noun in the `fact` template example — the entry\'s subject'],
  ['Slides', 'a noun in the `preference` template example'],
  ['Cloudflare', 'a vendor named in the tunnel examples'],
  ['Drive', 'Google Drive, in the `procedure` template example'],
  ['Every', 'the first word of a bullet, after the list marker'],
]);

/**
 * THE REPLACEMENT VOCABULARY — a CLOSED set, so the anonymising cannot drift into inventing a
 * new kind of placeholder per prompt, and `<Bob>` cannot pass for one.
 *
 * Roles, not people: who the party IS to the owner. The upper-case-free shape is deliberate —
 * these read as slots, and the name-shape rule below would flag `<Bob>` exactly as it flags a
 * bare name, so the two halves of the rule agree.
 */
const ROLE_PLACEHOLDERS = [
  '<the owner>', '<a contact>', '<another contact>', '<that contact>', '<an agent>',
  '<that agent>', '<a client>', '<an address>', '<their employer>', '<a first name>',
  '<their full name>',
] as const;

/** A position that makes the next word sentence-initial, so its capital says nothing. */
const SENTENCE_START = /(?:^|[.!?:;*("“[>])\s*$/;

function personShapedTokens(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/\b[A-Z][a-z]{2,}\b/g)) {
    if (SENTENCE_START.test(line.slice(0, m.index))) continue;
    if (NOT_A_PERSON.has(m[0])) continue;
    out.push(m[0]);
  }
  return out;
}

function linesFor(slot: typeof EXAMPLE_SLOTS[number]): string[] {
  const src = fs.readFileSync(path.join(REPO_ROOT, slot.file), 'utf-8');
  return src.split('\n').filter(l => slot.anchor.test(l));
}

describe('owner ruling #5 — example people in shipped prompts are role placeholders', () => {
  it('every anchor still finds its lines — a scan that matched nothing would report a clean sweep', () => {
    for (const slot of EXAMPLE_SLOTS) {
      expect(linesFor(slot).length, `${slot.file} :: ${slot.what}`).toBeGreaterThan(0);
    }
    expect(EXAMPLE_SLOTS.length).toBeGreaterThanOrEqual(5);
  });

  it('⚠ no example slot names a person', () => {
    const found: string[] = [];
    for (const slot of EXAMPLE_SLOTS) {
      for (const line of linesFor(slot)) {
        for (const token of personShapedTokens(line)) {
          found.push(`${slot.file}: ${token} — in: ${line.trim().slice(0, 110)}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it('⚠ and each slot still names its ROLES — the examples were anonymised, not deleted', () => {
    // The other direction, and it is the one that matters for the prompts themselves. Stripping
    // the examples out would satisfy the clause above and leave every surface worse; the ruling
    // says ANONYMISE, not remove. So each slot carries an EXACT count of role placeholders,
    // measured after the sweep: deleting one reds, and ADDING one reds too and has to be
    // declared here — which is what makes this a census rather than a floor.
    for (const slot of EXAMPLE_SLOTS) {
      const text = linesFor(slot).join('\n');
      const used = ROLE_PLACEHOLDERS.reduce((n, r) => n + text.split(r).length - 1, 0);
      expect(used, `${slot.file} :: ${slot.what}`).toBe(slot.roles);
    }
    // And the corpus total, said once, so a slot losing examples to a sibling gaining them is
    // not a wash.
    expect(EXAMPLE_SLOTS.reduce((n, s2) => n + s2.roles, 0)).toBe(17);
  });

  it('⚠ CONTROLS — the detector refuses a planted name and accepts the placeholder it replaced', () => {
    expect(personShapedTokens('([USER · Sam], [USER · Alex Chen (imessage)])')).toEqual(['Sam', 'Alex', 'Chen']);
    expect(personShapedTokens('([USER · <the owner>], [USER · <a contact> (imessage)])')).toEqual([]);
    expect(personShapedTokens('| `event` | `<x>.` | `Verve Health deck shipped.` |')).toEqual(['Verve', 'Health']);
    expect(personShapedTokens('| `event` | `<x>.` | `<a client> deck shipped.` |')).toEqual([]);
    // Sentence-initial and ALL-CAPS stay exempt, or the rule would flag ordinary prose.
    expect(personShapedTokens('Conversation attribution: a SPECIFIC person or channel.')).toEqual([]);
    // And the declared vocabulary is spent on the words it says it is, not on a name.
    expect([...NOT_A_PERSON.keys()].every(w => /^[A-Z][a-z]{2,}$/.test(w))).toBe(true);
    expect(NOT_A_PERSON.size).toBeLessThanOrEqual(8);
    // A placeholder spelled with a capital is a name wearing brackets, and the name-shape rule
    // already refuses it — stated here so the two halves of the rule are visibly consistent.
    expect(ROLE_PLACEHOLDERS.filter(r => /[A-Z]/.test(r))).toEqual([]);
    expect(personShapedTokens('[USER · <Bob>]')).toEqual(['Bob']);
  });
});
