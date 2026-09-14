// ════════════════════════════════════════════════════════════════════════════════
// THE PANEL FOLDS, AND ITS SECTIONS REVEAL THEIR CHILDREN (UX-ACCESS A5) — RED-first.
//
// Three owner orders, 2026-09-13, all of them about the SAME shape: a section is
// a switch, and what the switch governs is only on screen when it is on.
//
//   1. THE PANEL ITSELF collapses, and opens COLLAPSED. It is the tallest card on
//      the agent editor (38 tool groups, five channels, every published
//      technique) and it opened fully expanded above every other card.
//   2. TOOLS become a two-option selector — "Full tool access" / "Individual tool
//      access" — and the 38 checkboxes render only under the second.
//   3. TECHNIQUES get a "Technique access" switch; the list appears beneath it,
//      all checked, and vanishes when it is off.
//   4. CHANNELS stop rendering DISABLED children under a `false` master and
//      render NO children at all; flipping the master on defaults them to the
//      "Only me" tier.
//
// ── WHY THE CHANNEL DEFAULT IS `owner` AND NOT `all` ──
// Owner ruling 1 draws a me-vs-other-people tier, and A4 gave it its first
// server-side reader. A master flip is a statement that this agent may talk to
// people; it is NOT a statement about WHICH people. So the flip defaults the
// tier that reaches exactly one person — the owner — and "anyone approved" stays
// a second, deliberate click per channel. Nothing here saves until Save.
//
// ── AND WHY FLIPPING THE MASTER OFF DOES NOT ERASE ──
// A3 made the per-channel value survive a `false` master on purpose
// (`channelTierOf` applies the master, so the stored tier is inert rather than
// gone). That property is what makes off→on restore the owner's own set instead
// of re-defaulting over it, so the "default on" rule fires only when there is
// nothing to restore.
//
// This file tests the panel's PURE MATH by importing it, and censuses the React
// shape the Playwright drive then exercises for real.
//
// RED AT `eff652d4`: `toolMode` / `setToolMode` / `techniqueAccessOn` /
// `setTechniqueAccess` / `credentialsGranted` / `setCredentials` are not
// exported; `setMaster` never touches a channel; `usePanelCollapse` takes one
// argument; `AccessPanel.tsx` contains no collapse at all.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACCESS_CHANNELS, MOST_RESTRICTIVE_GRANTS, cloneGrants, techniqueGrantOf } from '@dojo/shared';
import type { AccessGrants } from '@dojo/shared';
import {
  clone, categoryChecked, toolMode, setToolMode, setCategory,
  credentialsGranted, setCredentials,
  techniqueAccessOn, setTechniqueAccess, techniqueChecked, setTechnique,
  setMaster, masterOn, hasMaster, grantsPatch, isDirty,
} from '../../../../../dashboard/src/lib/access-edits.js';

const DASH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', 'dashboard', 'src',
);
const readDash = (rel: string): string => fs.readFileSync(path.join(DASH, rel), 'utf8');

const LABELS = ['Meta', 'File & System', 'Web', 'Communication'];
const IDS = ['tech-a', 'tech-b', 'tech-c'];

/** The shape every one of the 111 live agents carries: wide open, master on. */
const wide = (): AccessGrants => {
  const g = cloneGrants(MOST_RESTRICTIVE_GRANTS);
  g.tools.categories = '*';
  g.integrations.credentials = true;
  g.channels.master = true;
  for (const c of ACCESS_CHANNELS) g.channels[c] = 'all';
  g.techniques = '*';
  return g;
};

const floor = (): AccessGrants => cloneGrants(MOST_RESTRICTIVE_GRANTS);

// ════════════════════════════════════════════════════════════════════════════════
// 1 · TOOLS — two options, and the flip never narrows
// ════════════════════════════════════════════════════════════════════════════════

describe('the tools section is a mode, not a checkbox', () => {
  it('⚠ EVERY MIGRATED AGENT READS "FULL" — `"*"` IS THE FULL MODE', () => {
    expect(toolMode(wide())).toBe('full');
  });

  it('a bounded list reads "individual"', () => {
    expect(toolMode(floor())).toBe('individual');
  });

  it('⚠ FULL → INDIVIDUAL PRE-FILLS FROM THE EFFECTIVE SET — it never blanks the boxes', () => {
    // The whole hazard of the flip: `'*'` means "every group, including future
    // ones", so the honest expansion is today's whole list. Writing `[]` here
    // would silently strip every tool the agent holds the moment the owner
    // looked at the control.
    const next = setToolMode(wide(), 'individual', LABELS);
    expect(next.tools.categories).toEqual(LABELS);
    for (const label of LABELS) expect(categoryChecked(next, label), `${label} stays ticked`).toBe(true);
  });

  it('INDIVIDUAL → FULL is the `"*"` promise about the future', () => {
    expect(setToolMode(floor(), 'full', LABELS).tools.categories).toBe('*');
  });

  it('and the per-group ticks still work under "individual"', () => {
    const individual = setToolMode(wide(), 'individual', LABELS);
    const minusWeb = setCategory(individual, 'Web', false, LABELS);
    expect(categoryChecked(minusWeb, 'Web')).toBe(false);
    expect(categoryChecked(minusWeb, 'Meta')).toBe(true);
    expect(toolMode(minusWeb)).toBe('individual');
  });

  it('⚠ MERELY OPENING THE PANEL SAVES NOTHING — the mode is read, not written', () => {
    const stored = wide();
    expect(isDirty(stored, clone(stored))).toBe(false);
    expect(grantsPatch(stored, clone(stored))).toEqual({});
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 2 · CREDENTIALS — one switch
// ════════════════════════════════════════════════════════════════════════════════

describe('the credentials section is one switch', () => {
  it('⚠ IT READS AND WRITES THE BOOLEAN, AND THERE IS NO PER-NAME CONTROL LEFT', async () => {
    const edits = await import('../../../../../dashboard/src/lib/access-edits.js') as Record<string, unknown>;
    for (const gone of ['credentialChecked', 'setCredential', 'setEveryCredential', 'grantsEveryCredential']) {
      expect(gone in edits, `${gone} is deleted, not left with one caller`).toBe(false);
    }
    expect(credentialsGranted(wide())).toBe(true);
    expect(credentialsGranted(floor())).toBe(false);
    expect(setCredentials(floor(), true).integrations.credentials).toBe(true);
    expect(setCredentials(wide(), false).integrations.credentials).toBe(false);
  });

  it('the patch carries the boolean, like Plaud beside it', () => {
    const stored = wide();
    expect(grantsPatch(stored, setCredentials(stored, false))).toEqual({ integrations: { credentials: false } });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 3 · TECHNIQUES — a switch that reveals a list, all checked
// ════════════════════════════════════════════════════════════════════════════════

describe('the techniques section is a switch over a list', () => {
  it('⚠ AN AGENT HOLDING `"*"` READS "ON", AND EVERY TECHNIQUE READS CHECKED', () => {
    const g = wide();
    expect(techniqueAccessOn(g)).toBe(true);
    for (const id of IDS) expect(techniqueChecked(g, id), `${id} is checked`).toBe(true);
  });

  it('⚠ A ROW WRITTEN BEFORE A4 (NO `techniques` KEY) READS "ON" TOO', () => {
    const g = wide();
    delete g.techniques;
    expect(techniqueAccessOn(g)).toBe(true);
    expect(techniqueChecked(g, 'anything')).toBe(true);
    // …and opening the panel on it and pressing Save sends nothing.
    expect(grantsPatch(g, clone(g))).toEqual({});
  });

  it('OFF grants nothing at all', () => {
    const off = setTechniqueAccess(wide(), false, IDS);
    expect(techniqueAccessOn(off)).toBe(false);
    expect(techniqueGrantOf(off)).toEqual([]);
    for (const id of IDS) expect(techniqueChecked(off, id)).toBe(false);
  });

  it('⚠ ON DEFAULTS TO ALL CHECKED — including techniques published later', () => {
    const on = setTechniqueAccess(setTechniqueAccess(wide(), false, IDS), true, IDS);
    expect(techniqueAccessOn(on)).toBe(true);
    expect(techniqueGrantOf(on)).toBe('*');
  });

  it('unchecking one removes exactly that technique and leaves the switch on', () => {
    const minusB = setTechnique(wide(), 'tech-b', false, IDS);
    expect(techniqueChecked(minusB, 'tech-b')).toBe(false);
    expect(techniqueChecked(minusB, 'tech-a')).toBe(true);
    expect(techniqueAccessOn(minusB)).toBe(true);
  });

  it('unchecking the LAST one turns the switch off, because an empty grant is off', () => {
    let g: AccessGrants = wide();
    for (const id of IDS) g = setTechnique(g, id, false, IDS);
    expect(techniqueGrantOf(g)).toEqual([]);
    expect(techniqueAccessOn(g)).toBe(false);
  });

  it('the old "every technique" checkbox helpers are gone', async () => {
    const edits = await import('../../../../../dashboard/src/lib/access-edits.js') as Record<string, unknown>;
    for (const gone of ['grantsEveryTechnique', 'setEveryTechnique', 'grantsEveryCategory']) {
      expect(gone in edits, `${gone} is deleted`).toBe(false);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 4 · CHANNELS — the master reveals its children and defaults them to "Only me"
// ════════════════════════════════════════════════════════════════════════════════

describe('the master switch reveals its children', () => {
  it('⚠ FLIPPING IT ON DEFAULTS EVERY CHANNEL TO "ONLY ME", NEVER TO "ANYONE APPROVED"', () => {
    const g = setMaster(floor(), true);
    expect(masterOn(g)).toBe(true);
    for (const c of ACCESS_CHANNELS) {
      expect(g.channels[c], `${c} defaults to the owner tier`).toBe('owner');
    }
  });

  it('⚠ …AND NEVER OVERWRITES A SET THE OWNER ALREADY CHOSE', () => {
    const custom = floor();
    custom.channels.imessage = 'all';
    const g = setMaster(custom, true);
    expect(g.channels.imessage).toBe('all');
    for (const c of ACCESS_CHANNELS) {
      if (c === 'imessage') continue;
      expect(g.channels[c], `${c} was left alone`).toBe('none');
    }
  });

  it('⚠ OFF → ON INSIDE ONE SESSION RESTORES THE DRAFT, IT DOES NOT RE-DEFAULT', () => {
    // A3 kept the per-channel value alive under a `false` master on purpose.
    // This is what that property BUYS: an owner who unticks four channels, flips
    // the master off to look at something and flips it back gets his own set.
    let g: AccessGrants = setMaster(floor(), true);            // all five 'owner'
    g = { ...g, channels: { ...g.channels, sms: 'none', voice: 'none', email: 'none', teams: 'none' } };
    const off = setMaster(g, false);
    for (const c of ACCESS_CHANNELS) {
      expect(off.channels[c], `${c} survives the master going off`).toBe(g.channels[c]);
    }
    const backOn = setMaster(off, true);
    expect(backOn.channels.imessage).toBe('owner');
    expect(backOn.channels.sms).toBe('none');
    expect(backOn.channels.voice).toBe('none');
  });

  it('an agent with NO master switch is untouched by any of this', () => {
    const sensei = floor();
    sensei.channels.master = null;
    expect(hasMaster(sensei)).toBe(false);
    expect(grantsPatch(sensei, clone(sensei))).toEqual({});
  });

  it('THE 111-CONTROL: opening the panel on a live agent and saving sends nothing', () => {
    const stored = wide();
    expect(grantsPatch(stored, clone(stored))).toEqual({});
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 5 · THE REACT SHAPE — the census the Playwright drive then exercises
// ════════════════════════════════════════════════════════════════════════════════

describe('the panel is a collapsible card that opens collapsed', () => {
  const panel = (): string => readDash('components/AccessPanel.tsx');

  it('⚠ IT REUSES THE DASHBOARD\'S ONE COLLAPSE IDIOM — no second implementation', () => {
    const src = panel();
    expect(src).toContain("from './CollapseToggle'");
    expect(src).toMatch(/usePanelCollapse\(/);
    expect(src).toMatch(/<CollapseToggle/);
  });

  it('⚠ AND IT ASKS FOR COLLAPSED BY DEFAULT', () => {
    expect(panel()).toMatch(/usePanelCollapse\(\s*'[^']+'\s*,\s*true\s*\)/);
  });

  it('the collapse hook carries the default itself, so no caller re-implements it', () => {
    const hook = readDash('components/CollapseToggle.tsx');
    expect(hook).toMatch(/usePanelCollapse\(\s*storageKey: string,\s*defaultCollapsed/);
    expect(hook).toMatch(/isCollapsed/);
  });

  it('⚠ THE THREE OLDER CALLERS ASK THE SAME WAY — one reader, not two', () => {
    for (const file of ['GoogleWorkspaceSettings', 'MicrosoftWorkspaceSettings', 'TwilioSettings']) {
      const src = readDash(`components/${file}.tsx`);
      expect(src, `${file} asks through isCollapsed`).toMatch(/isCollapsed\(/);
      expect(src, `${file} no longer re-defaults at the call site`).not.toMatch(/collapsed\[[^\]]+\]\s*\?\?/);
    }
  });
});

describe('each section shows only what its switch governs', () => {
  const panel = (): string => readDash('components/AccessPanel.tsx');

  it('⚠ TOOLS: the owner\'s two option labels, and the grid is conditional', () => {
    const src = panel();
    expect(src).toContain('Full tool access');
    expect(src).toContain('Individual tool access');
    expect(src).toMatch(/toolMode\(draft\) === 'individual' &&/);
  });

  it('⚠ CREDENTIALS: one control, with the owner\'s words', () => {
    const src = panel();
    // A5's label was "Access to stored credentials"; A6's language pass renames
    // it to the words the owner used. ONE control over the whole field is the
    // requirement, and it is unchanged — what moved is the sentence on it.
    expect(src).toContain('Use stored keys & logins');
    // The per-credential rows are gone, and with them the reason the panel had to
    // fetch the vault's contents at all. (The tombstone comment naming the
    // deleted call stays — that is what a grep for the old behaviour should
    // find — so the assertion is about the CALL, not the word.)
    expect(src).not.toMatch(/api\.listCredentials/);
    expect(src).not.toContain('Every stored credential');
  });

  it('⚠ TECHNIQUES: a switch, and the list beneath it', () => {
    const src = panel();
    // "Technique access" became "Can use techniques" in A6's language pass. The
    // switch, the list it reveals and the predicate behind both are unchanged.
    expect(src).toContain('Can use techniques');
    expect(src).toMatch(/techniqueAccessOn\(draft\)/);
  });

  it('⚠ CHANNELS: NO child renders under a `false` master — hidden, not dimmed', () => {
    const src = panel();
    // The A3 shape was `acx-children is-off` plus `disabled={!masterOn(draft)}` on
    // every row. The requirement it carried — owner ruling 1's "inert unless the
    // master is on" — is unchanged and still lives in `channelTierOf`; what moved
    // is that the panel no longer draws a control the owner cannot use.
    expect(src).not.toContain('is-off');
    expect(src).not.toMatch(/disabled=\{!masterOn\(draft\)\}/);
    expect(src).toMatch(/\bon && \(/);
  });

  it('the panel still computes no access of its own', () => {
    const src = panel();
    expect(src, 'never decides from the classification').not.toContain('classification');
    expect(src).toContain('effectiveGrants');
  });
});
