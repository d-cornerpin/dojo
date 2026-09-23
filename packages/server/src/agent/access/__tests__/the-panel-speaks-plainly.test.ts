// ════════════════════════════════════════════════════════════════════════════════
// ONE ACCESS PANEL, FIVE PLAIN QUESTIONS (UX-ACCESS A6) — RED-first.
//
// The owner's design, recorded verbatim in the brief:
//
//   · ONE "Access" panel, collapsed by default, whose COLLAPSED HEADER shows a
//     one-line plain-English digest of the agent's setup ("Full tools · talks to
//     you only · 3 connections"), derived from the stored object and always true.
//   · FIVE rows inside, each a plain QUESTION, each collapsed, each the
//     established master-toggle→children pattern:
//       1 What it can do      the tool-group selector
//       2 What it can reach   integrations in plain words, plus the two legacy
//                             reach toggles the owner named — "Run programs on
//                             this Mac" (exec) and the web — and the credential
//                             switch. The risky ones carry a warning tint.
//       3 Who it can talk to  the channels section, relabelled
//       4 What it knows       techniques, plus "knows who you are"
//       5 What it may manage  the legacy permission toggles, FOLDED IN from the
//                             agent editor's Permissions card, which is removed
//   · LANGUAGE: plain sentence-case labels, ZERO internal jargon on screen — no
//     "sensei", no "ronin", no "a2a" — help text one line, presets re-described.
//
// ── WHAT THIS FILE PINS, AND WHAT IT DELIBERATELY DOES NOT ──
// The fold is a REPOINTING: the legacy toggles keep writing the fields they
// always wrote (`permissions`, `tools_policy`, `config.shareUserProfile`), and
// the grants model does not move one byte this phase. So the load-bearing clause
// here is an IDENTITY: for every stored shape, the new pure module builds the
// SAME document the old editor built. Anything else would be a migration wearing
// a UI change's clothes.
//
// RED AT `9184d6cf`, measured: `lib/manifest-edits.ts` does not exist;
// `accessDigest` is not exported from `lib/access-edits.ts`; `AccessPanel.tsx`
// carries four titled sections and no questions; `AgentConfigPanel.tsx` still
// imports and renders `PermissionsEditor`.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACCESS_CHANNELS, MOST_RESTRICTIVE_GRANTS, cloneGrants } from '@dojo/shared';
import type { AccessGrants, PermissionManifest } from '@dojo/shared';
import { ACCESS_PRESETS } from '../presets.js';
import { accessDigest, toolsSummary, talkSummary, reachSummary, knowsSummary } from '../../../../../dashboard/src/lib/access-summary.js';
import {
  readLegacyAccess, buildLegacyAccess, legacyDirty, manageSummary, legacyReachSummary,
  programsAreEmpty, type LegacyAccess,
} from '../../../../../dashboard/src/lib/manifest-edits.js';

const DASH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', 'dashboard', 'src',
);
const readDash = (rel: string): string => fs.readFileSync(path.join(DASH, rel), 'utf8');

/** Source with every comment removed, so a clause about what the OWNER READS
 *  cannot be satisfied — or broken — by a tombstone comment naming the old
 *  behaviour. The repo's practice is to leave those comments; this is how a
 *  user-visible-copy assertion coexists with it. */
const withoutComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

const panel = (): string => readDash('components/AccessPanel.tsx');
const bits = (): string => readDash('components/AccessControls.tsx');
const manifestUi = (): string => readDash('components/AccessManifest.tsx');
const editor = (): string => readDash('pages/AgentConfigPanel.tsx');
/** Everything the Access panel puts on screen, comments stripped. */
const copy = (): string => withoutComments(panel() + bits() + manifestUi());

// ── Fixtures: three differently-configured agents, the brief's own request ──

/** Every live agent on the owner's box: wide open, master on, everything. */
const wide = (): AccessGrants => {
  const g = cloneGrants(MOST_RESTRICTIVE_GRANTS);
  g.tools.categories = '*';
  g.integrations.plaud = true;
  g.integrations.credentials = true;
  g.integrations.google = { agent: 'full', user: 'full' };
  g.channels.master = true;
  for (const c of ACCESS_CHANNELS) g.channels[c] = 'all';
  g.techniques = '*';
  return g;
};

/** A4's Reader exemplar: narrow tools, Plaud + one mail kind, no channel. */
const reader = (): AccessGrants => {
  const g = cloneGrants(MOST_RESTRICTIVE_GRANTS);
  g.tools.categories = ['Meta', 'File & System', 'Gmail'];
  g.integrations.plaud = true;
  g.integrations.google = { agent: 'read', user: 'none' };
  g.techniques = [];
  return g;
};

/** A helper agent that talks through the main agent — `master === null`. */
const helper = (): AccessGrants => {
  const g = reader();
  g.channels.master = null;
  return g;
};

/** The owner's own shape: master on, one channel, owner tier only. */
const onlyMe = (): AccessGrants => {
  const g = cloneGrants(MOST_RESTRICTIVE_GRANTS);
  g.tools.categories = '*';
  g.integrations.plaud = true;
  g.integrations.credentials = true;
  g.integrations.google = { agent: 'read', user: 'none' };
  g.channels.master = true;
  g.channels.imessage = 'owner';
  return g;
};

// ════════════════════════════════════════════════════════════════════════════════
// 1 · THE DIGEST — one line, on the folded card, and TRUE
// ════════════════════════════════════════════════════════════════════════════════

describe('the collapsed header says what this agent is, in one plain line', () => {
  it('⚠ THE OWNER\'S OWN EXAMPLE SHAPE: "Full tools · talks to you only · 3 connections"', () => {
    // Plaud + the credential store + one Google kind = three connections.
    expect(accessDigest(onlyMe(), { runsPrograms: false }))
      .toBe('Full tools · talks to you only · 3 connections');
  });

  it('⚠ A WIDE-OPEN AGENT SAYS SO, AND NAMES THE WIDER TIER', () => {
    expect(accessDigest(wide(), { runsPrograms: true }))
      .toBe('Full tools · talks to you and approved contacts · 4 connections · runs programs');
  });

  it('⚠ A NARROW READER SAYS SO TOO — no channel, and the count is exact', () => {
    expect(accessDigest(reader(), { runsPrograms: false }))
      .toBe('3 tool groups · talks to no one · 2 connections');
  });

  it('⚠ A HELPER AGENT IS DESCRIBED WITHOUT THE WORD FOR IT', () => {
    const line = accessDigest(helper(), { runsPrograms: false });
    expect(line).toContain('talks through your main agent');
    expect(line.toLowerCase()).not.toContain('sensei');
    expect(line.toLowerCase()).not.toContain('ronin');
  });

  it('the floor agent reads as the floor — nothing claimed that is not held', () => {
    // 3 → 5 (owner ruling, 2026-09-22): the two work-tracker groups are part of
    // the floor now. The count is DERIVED from the object, so it moved with it —
    // which is the property this line exists to hold. Still "talks to no one" and
    // "no connections": a tracker row is inside this box.
    expect(accessDigest(cloneGrants(MOST_RESTRICTIVE_GRANTS), { runsPrograms: false }))
      .toBe('5 tool groups · talks to no one · no connections');
  });

  it('⚠ IT IS DERIVED, NOT REMEMBERED — every clause moves when the object moves', () => {
    const g = onlyMe();
    const before = accessDigest(g, { runsPrograms: false });
    g.integrations.plaud = false;
    g.channels.imessage = 'all';
    g.tools.categories = ['Meta'];
    const after = accessDigest(g, { runsPrograms: false });
    expect(after).not.toBe(before);
    expect(after).toBe('1 tool group · talks to you and approved contacts · 2 connections');
  });

  it('singular and plural are both written, because "1 connections" is a tell', () => {
    const g = cloneGrants(MOST_RESTRICTIVE_GRANTS);
    g.integrations.plaud = true;
    expect(accessDigest(g, { runsPrograms: false })).toContain('1 connection');
    expect(accessDigest(g, { runsPrograms: false })).not.toContain('1 connections');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 2 · THE FIVE ROW SUMMARIES — the same derivation, one row at a time
// ════════════════════════════════════════════════════════════════════════════════

describe('each row says its own state on its folded header', () => {
  // Everything off. The web pair needs saying explicitly: a MISSING tools policy
  // has always meant "all tools", so an empty blob reads the two web toggles ON.
  const off: LegacyAccess = readLegacyAccess(
    {}, { allow: [], deny: ['web_search', 'web_fetch', 'web_browse'] }, false,
  );

  it('what it can do', () => {
    expect(toolsSummary(wide())).toBe('Full tool access');
    expect(toolsSummary(reader())).toBe('3 tool groups');
  });

  it('what it can reach — the grants and the two legacy reach toggles, in one phrase', () => {
    expect(reachSummary(reader(), { web: false, programs: false })).toBe('Plaud, 1 account');
    expect(reachSummary(wide(), { web: true, programs: true }))
      .toBe('Plaud, 2 accounts, stored keys, the web, programs');
    expect(reachSummary(cloneGrants(MOST_RESTRICTIVE_GRANTS), { web: false, programs: false })).toBe('Nothing');
  });

  it('who it can talk to', () => {
    expect(talkSummary(helper())).toBe('Through your main agent');
    expect(talkSummary(reader())).toBe('No one');
    expect(talkSummary(onlyMe())).toBe('You only, on iMessage');
    expect(talkSummary(wide())).toBe('You and approved contacts, on 5 channels');
  });

  it('what it knows', () => {
    expect(knowsSummary(wide(), true)).toBe('All techniques, knows who you are');
    expect(knowsSummary(reader(), false)).toBe('No techniques');
  });

  it('what it may manage', () => {
    expect(manageSummary(off)).toBe('Nothing');
    const all = { ...off, readOn: true, screenOn: true, spawnOn: true };
    expect(manageSummary(all)).toBe('Your files, this Mac, other agents');
  });

  it('⚠ THE REACH SUMMARY READS THE VALUE, NOT THE SWITCH', () => {
    // Found in the A6 Playwright drive: the old "Run Terminal Commands" switch
    // goes on with an EMPTY command list, and an empty `exec_allow` grants
    // nothing — so a summary that read the switch would say "programs" about an
    // agent about to be refused every command. The storage rule is untouched.
    expect(legacyReachSummary(off)).toEqual({ web: false, programs: false });
    expect(legacyReachSummary({ ...off, execOn: true })).toEqual({ web: false, programs: false });
    expect(programsAreEmpty({ ...off, execOn: true })).toBe(true);
    expect(legacyReachSummary({ ...off, execOn: true, execList: 'ls' })).toEqual({ web: false, programs: true });
    expect(legacyReachSummary({ ...off, execOn: true, execAll: true })).toEqual({ web: false, programs: true });
    expect(programsAreEmpty({ ...off, execOn: true, execAll: true })).toBe(false);
    expect(legacyReachSummary({ ...off, browseOn: true })).toEqual({ web: true, programs: false });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 3 · THE FOLD IS A REPOINTING — the same document, from the same stored shape
// ════════════════════════════════════════════════════════════════════════════════

describe('the moved legacy toggles write exactly what they always wrote', () => {
  const stored: Partial<PermissionManifest> = {
    file_read: ['~/Projects/**'],
    file_write: '*',
    file_delete: ['/tmp/**'],
    exec_allow: ['ls', 'cat'],
    exec_deny: ['rm -rf /'],
    network_domains: '*',
    max_processes: 5,
    can_spawn_agents: true,
    can_assign_permissions: false,
    system_control: ['screen', 'web_browse'],
  };
  const tools = { allow: [], deny: ['web_search', 'web_fetch'] };

  it('⚠ READ THEN BUILD IS THE IDENTITY — opening the panel changes nothing', () => {
    const built = buildLegacyAccess(readLegacyAccess(stored, tools, true));
    expect(built.permissions).toEqual({
      file_read: ['~/Projects/**'],
      file_write: '*',
      file_delete: ['/tmp/**'],
      exec_allow: ['ls', 'cat'],
      exec_deny: ['rm -rf /'],
      network_domains: '*',
      max_processes: 5,
      can_spawn_agents: true,
      can_assign_permissions: false,
      system_control: ['screen', 'web_browse'],
    });
    expect(built.toolsPolicy).toEqual({ allow: [], deny: ['web_search', 'web_fetch'] });
    expect(built.shareUserProfile).toBe(true);
  });

  it('⚠ AND SO IT IS NEVER DIRTY ON ARRIVAL — a save sends the manifest only when one moved', () => {
    const s = readLegacyAccess(stored, tools, true);
    expect(legacyDirty(s, { ...s })).toBe(false);
    expect(legacyDirty(s, { ...s, spawnOn: false })).toBe(true);
  });

  it('an EMPTY stored blob reads as the all-off shape, exactly as the old editor did', () => {
    const s = readLegacyAccess({}, undefined, false);
    expect(s.readOn).toBe(false);
    expect(s.execOn).toBe(false);
    expect(s.spawnOn).toBe(false);
    expect(s.maxProcesses).toBe(3);
    // `hasToolAccess(undefined, …)` answered "all tools" for a missing policy,
    // which is why an agent with no policy reads the web toggles as ON.
    expect(s.searchOn).toBe(true);
    expect(s.browseOn).toBe(true);
  });

  it('⚠ "Run programs on this Mac" IS `exec_allow`, AND OFF MEANS THE EMPTY LIST', () => {
    const s = readLegacyAccess(stored, tools, false);
    expect(s.execOn).toBe(true);
    expect(s.execList).toBe('ls, cat');
    expect(buildLegacyAccess({ ...s, execOn: false }).permissions.exec_allow).toEqual([]);
    expect(buildLegacyAccess({ ...s, execAll: true }).permissions.exec_allow).toEqual(['*']);
  });

  it('⚠ THE WEB TOGGLES REACH BOTH FIELDS THE OLD ONES REACHED', () => {
    const s = readLegacyAccess(stored, tools, false);
    expect(s.searchOn).toBe(false);           // denied in the policy
    expect(s.browseOn).toBe(true);            // `web_browse` in system_control
    const bothOff = buildLegacyAccess({ ...s, searchOn: false, browseOn: false });
    expect(bothOff.toolsPolicy.deny).toEqual(['web_search', 'web_fetch', 'web_browse']);
    expect(bothOff.permissions.system_control).not.toContain('web_browse');
    expect(bothOff.permissions.network_domains).toBe('none');
  });

  it('⚠ AND THE SEARCH TOGGLE CAN BE TURNED BACK ON — the old one could not', () => {
    // The defect: `rawToolsDeny` was seeded from the STORED deny, which already
    // held `web_search`, and the build merged the raw list back in. So the
    // toggle could be turned off and never on again — a control that lies, which
    // is the disease this overhaul exists to end. The advanced field now carries
    // only the denies no toggle owns.
    const s = readLegacyAccess(stored, tools, false);
    expect(s.rawDeny).toBe('');
    expect(buildLegacyAccess({ ...s, searchOn: true }).toolsPolicy.deny).toEqual([]);
  });

  it('a deny no toggle owns survives the round trip', () => {
    const s = readLegacyAccess(stored, { allow: [], deny: ['spawn_agent'] }, false);
    expect(s.rawDeny).toBe('spawn_agent');
    expect(buildLegacyAccess(s).toolsPolicy.deny).toEqual(['spawn_agent']);
  });

  it('⚠ THE DELETE SUB-OPTION TELLS THE TRUTH ABOUT WHAT IT WRITES', () => {
    // The old label was "All files" and it wrote `['/tmp/**']`. The write is
    // unchanged; the label and the read-back now agree with it.
    const s = readLegacyAccess(stored, tools, false);
    expect(s.deleteOn).toBe(true);
    expect(s.deleteTmp).toBe(true);
    expect(buildLegacyAccess(s).permissions.file_delete).toEqual(['/tmp/**']);
    expect(buildLegacyAccess({ ...s, deleteOn: false }).permissions.file_delete).toBe('none');
  });

  it('the delegation pair still writes the manifest booleans the doors read', () => {
    const s = readLegacyAccess(stored, tools, false);
    expect(buildLegacyAccess({ ...s, spawnOn: false }).permissions.can_spawn_agents).toBe(false);
    expect(buildLegacyAccess({ ...s, assignOn: true }).permissions.can_assign_permissions).toBe(true);
  });

  it('⚠ IT WRITES NO KEY THE OLD EDITOR DID NOT WRITE — a fold, not a re-key', () => {
    const built = buildLegacyAccess(readLegacyAccess(stored, tools, false));
    expect(Object.keys(built.permissions).sort()).toEqual([
      'can_assign_permissions', 'can_spawn_agents', 'exec_allow', 'exec_deny',
      'file_delete', 'file_read', 'file_write', 'max_processes', 'network_domains',
      'system_control',
    ]);
    expect(Object.keys(built).sort()).toEqual(['permissions', 'shareUserProfile', 'toolsPolicy']);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 4 · THE PANEL — five questions, one card, and the emptied card is gone
// ════════════════════════════════════════════════════════════════════════════════

describe('one panel, five plain questions', () => {
  const QUESTIONS = [
    'What it can do',
    'What it can reach',
    'Who it can talk to',
    'What it knows',
    'What it may manage',
  ];

  it('⚠ ALL FIVE ARE ON THE CARD, AS QUESTIONS', () => {
    const src = panel();
    for (const q of QUESTIONS) expect(src, `the "${q}" row`).toContain(q);
  });

  it('⚠ AND THE OLD SECTION TITLES ARE GONE — this is a replacement, not an addition', () => {
    const src = withoutComments(panel());
    for (const old of ['title="Tools"', 'title="Integrations"', 'title="Channels"', 'title="Techniques"']) {
      expect(src, `${old} was replaced by a question`).not.toContain(old);
    }
  });

  it('⚠ EVERY ROW COLLAPSES, THROUGH THE ONE COLLAPSE IDIOM', () => {
    const src = panel();
    expect(src).toContain("from './CollapseToggle'");
    expect(src).toMatch(/usePanelCollapse\(\s*'[^']+'\s*,\s*true\s*\)/);
    // One <Row> per question, each asking the same hook for its own key.
    expect((src.match(/<Row\b/g) ?? []).length).toBe(5);
    expect(src).toMatch(/isCollapsed\(/);
  });

  it('the card itself still opens collapsed, with the digest on its header', () => {
    const src = panel();
    expect(src).toMatch(/accessDigest\(/);
    expect(src).toMatch(/<CollapseToggle/);
  });

  it('⚠ THE DIGEST IS BUILT FROM THE STORED OBJECT, NEVER FROM THE DRAFT', () => {
    // A shut card that reports an unsaved edit as if it were saved is a lie the
    // owner cannot see to correct. A5 established this; A6 keeps it.
    expect(panel()).toMatch(/accessDigest\(\s*stored/);
  });
});

describe('the legacy permission toggles moved, and the card they were on is gone', () => {
  it('⚠ THE AGENT EDITOR NO LONGER MOUNTS THE PERMISSIONS EDITOR', () => {
    const src = editor();
    expect(src).not.toContain('<PermissionsEditor');
    expect(src).not.toMatch(/import \{ PermissionsEditor/);
    expect(src, 'the emptied card is removed, not left as a shell').not.toMatch(/scard__title">Permissions/);
  });

  it('⚠ THE OLD EDITOR SURVIVES ONLY WHERE IT IS STILL THE ONLY CONTROL', () => {
    // `PermissionsEditor` is still mounted by the CREATE-AN-AGENT modal, which
    // is a different moment: there is no agent row yet, so there is no Access
    // panel to fold it into. Named here rather than deleted quietly, because a
    // component with one remaining caller is exactly the kind of leftover that
    // starts drifting from the surface that replaced it.
    expect(readDash('pages/Agents.tsx')).toContain('PermissionsEditor');
    expect(editor(), 'but not by the agent editor').not.toContain('PermissionsEditor');
  });

  it('⚠ AND THE CARDS THAT ARE NOT PERMISSIONS ARE UNTOUCHED', () => {
    const src = editor();
    for (const kept of ['Name', 'Model', 'Classification', 'System Prompt', 'Memory']) {
      expect(src, `the ${kept} card stays`).toContain(kept);
    }
  });

  it('⚠ EVERY MOVED TOGGLE IS ON THE PANEL, IN PLAIN WORDS', () => {
    const src = copy();
    for (const label of [
      'Run programs on this Mac',        // exec_allow
      'Search the web',                  // tools_policy web_search/web_fetch
      'Open web pages',                  // system_control web_browse
      'Use stored keys & logins',        // the credential grant
      'Read your files',                 // file_read
      'Change and create files',         // file_write
      'Delete files',                    // file_delete
      'See your screen',                 // system_control screen
      'Move the mouse',                  // system_control mouse
      'Type on the keyboard',            // system_control keyboard
      'Automate Mac apps',               // system_control applescript
      'Create helper agents',            // can_spawn_agents
      'Set what other agents may do',    // can_assign_permissions
      'Knows who you are',               // config.shareUserProfile
    ]) {
      expect(src, `"${label}" is on the panel`).toContain(label);
    }
  });

  it('⚠ THE RISKY ONES CARRY ONE CONSISTENT WARNING TINT', () => {
    const src = manifestUi() + panel();
    // One class, set from one prop, so "risky" looks the same everywhere.
    expect(bits()).toMatch(/is-risk/);
    expect((src.match(/\brisk\b/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });

  it('⚠ A BUILT-IN AGENT\'S MANIFEST IS STILL NOT EDITABLE HERE', () => {
    // Today's rule, carried across unchanged: the agent editor rendered a NOTE
    // instead of the permissions editor for every platform agent. The panel must
    // keep that, and it must not learn the classification to do it — the parent
    // knows which agent is which and says so through one prop.
    expect(editor()).toMatch(/manifestEditable=\{/);
    expect(panel()).toMatch(/manifestEditable/);
    expect(withoutComments(panel()), 'the panel never reads the classification')
      .not.toContain('classification');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 5 · THE LANGUAGE RULES — measured on the copy, not promised in a comment
// ════════════════════════════════════════════════════════════════════════════════

describe('nothing on this panel speaks the dojo\'s internal language', () => {
  const JARGON = ['sensei', 'ronin', 'apprentice', 'a2a', 'über', 'uber toggle', 'grants object'];

  it('⚠ NO INTERNAL WORD SURVIVES ANYWHERE THE OWNER CAN READ IT', () => {
    const src = copy().toLowerCase();
    for (const word of JARGON) {
      expect(src, `"${word}" is internal language and must not be on screen`).not.toContain(word);
    }
  });

  it('⚠ THE HELPER-AGENT NOTE SAYS WHAT IT MEANS INSTEAD OF NAMING THE RANK', () => {
    const src = copy();
    expect(src).toMatch(/talks through your main agent/i);
  });

  it('the presets are described in plain words, one line each', () => {
    for (const p of ACCESS_PRESETS) {
      expect(p.description.length, `${p.id} says what it does`).toBeGreaterThan(0);
      expect(p.description.length, `${p.id}'s description stays one line`).toBeLessThanOrEqual(120);
      for (const word of JARGON) {
        expect(p.description.toLowerCase(), `${p.id} avoids "${word}"`).not.toContain(word);
      }
    }
  });

  it('⚠ "Reader" IS DESCRIBED THE WAY THE OWNER DESCRIBED IT', () => {
    const reader = ACCESS_PRESETS.find((p) => p.id === 'reader')!;
    expect(reader.description.toLowerCase()).toContain('looks at things');
    expect(reader.description.toLowerCase()).toContain('stays quiet');
  });

  it('⚠ AND THE PRESET GRANTS THEMSELVES DID NOT MOVE — words only', () => {
    // A6 was a language pass over the presets, not a re-grant. The four objects
    // are asserted field by field in `the-access-panel.test.ts`; this is the
    // clause that says A6 changed only the sentence beside them.
    //
    // THE ONE DELIBERATE MOVE SINCE, and it is a grant not a word: the owner's
    // 2026-09-22 ruling put the two work-tracker groups into the floor. The pin
    // is updated rather than loosened so the NEXT silent re-grant still fails
    // here — see `the-work-tracker-is-not-optional.test.ts` for why these two.
    const byId = (id: string) => ACCESS_PRESETS.find((p) => p.id === id)!;
    expect(byId('most_restrictive').grants.tools.categories).toEqual([
      'Meta', 'File & System', 'Managing Other Agents',
      'Open Work (what you still owe)',
      'Work Tracker (projects, tasks, reminders, promises)',
    ]);
    expect(byId('full_trust').grants.tools.categories).toBe('*');
    expect(byId('operator').grants.channels.imessage).toBe('owner');
    expect(byId('reader').grants.channels.master).toBe(false);
  });
});
