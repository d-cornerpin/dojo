// ════════════════════════════════════════════════════════════════════════════════════════
// A DASHBOARD-CREATED AGENT HOLDS CONVERSATION RECALL — OWNER RULING 2026-10-05 #4.
//
// Before this, a `Recruit Agent` form submission sent no `grants` at all (`pages/Agents.tsx`'s
// `createData` has no such field), so the route resolved ruling 2's most-restrictive floor and
// the new agent could not read its own thread. `memory/__tests__/the-engine-says-the-other-
// threads-exist.test.ts:416` records what that cost on a live box: the model reached the rows
// through nine `exec` calls instead.
//
// ── WHAT THESE CLAUSES HOLD, AND WHY EACH DIRECTION MATTERS ──
//  1. THE ADDITION: the default a dashboard create resolves against carries the category.
//  2. THE NON-ADDITION, which is as load-bearing as the addition. The resolved object differs
//     from the clamped floor in EXACTLY ONE leaf. A ruling that said "grant recall" must not
//     arrive as "grant recall and a channel"; a clause that only checked the addition would
//     stay green for that.
//  3. THE OTHER DOOR IS UNMOVED: an AGENT-driven spawn, which passes no base, still lands on
//     the floor. The floor itself is shared with `spawn_agent`, the squad paths and
//     `grantsDelta`'s audit arithmetic, and ruling #4 is about the button the OWNER presses.
//  4. THE LABEL IS REAL and its group still holds the recall tools — a default grant to a
//     re-filed label is a grant to an empty room.
//  5. THE WIRE, by call SHAPE: the route passes the constant as the resolver's base. Comments
//     are stripped first, so the paragraph above the call cannot satisfy this.
//  6. NO BACKFILL, as a census: the constant has exactly ONE production consumer. A boot
//     sweep or a migration that rewrote existing agents' stored grants would be a second one,
//     and it would red here and have to be argued — which is the recorded decision, not an
//     accident. (The reasoning is in `create-defaults.ts`'s header.)
//  7. THE CLAMP: a granter that does not hold the category gets a CREATE, not a 400.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  MOST_RESTRICTIVE_GRANTS, cloneGrants, categoryGranted, stableGrantsText, type AccessGrants,
} from '@dojo/shared';
import { DASHBOARD_CREATE_DEFAULT_GRANTS, DASHBOARD_DEFAULT_CATEGORIES } from '../create-defaults.js';
import { resolveSpawnGrants, clampGrantsTo } from '../authorize.js';
import { TOOL_CATEGORIES } from '../../../tools/categories.js';

const SERVER_SRC = path.resolve(__dirname, '../../..');
const ROUTE = path.join(SERVER_SRC, 'gateway/routes/agents.ts');
const RECALL = 'Conversation Recall';

/** A primary agent's holdings, as every real box has them: everything. */
const primaryHoldings = (): AccessGrants => {
  const g = cloneGrants(MOST_RESTRICTIVE_GRANTS);
  g.tools.categories = '*';
  return g;
};

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** What the create route resolves when the form sends no grants — which is what it sends. */
function dashboardCreate(granter: AccessGrants = primaryHoldings()): AccessGrants {
  const out = resolveSpawnGrants(undefined, granter, true, undefined, DASHBOARD_CREATE_DEFAULT_GRANTS);
  if (!out.ok) throw new Error(`the dashboard create default was refused: ${out.reason}`);
  return out.grants;
}

describe('owner ruling #4 — a dashboard-created agent can read its own threads', () => {
  it('⚠ the resolved default carries Conversation Recall', () => {
    expect(categoryGranted(dashboardCreate(), RECALL)).toBe(true);
  });

  it('⚠ and NOTHING else moved — exactly one leaf differs from the clamped floor', () => {
    const got = dashboardCreate();
    const floor = clampGrantsTo(MOST_RESTRICTIVE_GRANTS, primaryHoldings());

    // The one leaf, named: the category list, longer by exactly the ruling's labels.
    expect(got.tools.categories).toEqual([
      ...(floor.tools.categories as string[]), ...DASHBOARD_DEFAULT_CATEGORIES,
    ]);

    // Every other leaf, compared as text so a nested change cannot hide: identical.
    const withoutCategories = (g: AccessGrants): string => {
      const c = cloneGrants(g);
      c.tools.categories = [];
      return stableGrantsText(c);
    };
    expect(withoutCategories(got)).toBe(withoutCategories(floor));
  });

  it('⚠ an AGENT-driven spawn is untouched: no base passed, no recall', () => {
    const spawned = resolveSpawnGrants(undefined, primaryHoldings(), true);
    expect(spawned.ok).toBe(true);
    expect(spawned.ok && categoryGranted(spawned.grants, RECALL)).toBe(false);
    expect(spawned.ok && stableGrantsText(spawned.grants))
      .toBe(stableGrantsText(clampGrantsTo(MOST_RESTRICTIVE_GRANTS, primaryHoldings())));
  });

  it('⚠ the label is a real tool group, and that group still holds the recall tools', () => {
    const group = TOOL_CATEGORIES.find(c => c.label === RECALL);
    expect(group, `${RECALL} is a label in TOOL_CATEGORIES`).toBeDefined();
    // A grant to a group whose tools moved elsewhere is a grant to an empty room.
    expect(group!.tools).toContain('recall_recent_thread');
    expect(group!.tools.some(t => t.startsWith('history_'))).toBe(true);
    for (const label of DASHBOARD_DEFAULT_CATEGORIES) {
      expect(TOOL_CATEGORIES.map(c => c.label)).toContain(label);
    }
  });

  it('⚠ THE WIRE: the create route passes the constant as the resolver\'s base', () => {
    const src = stripComments(fs.readFileSync(ROUTE, 'utf-8'));
    const call = src.match(/resolveSpawnGrants\(([\s\S]*?)\);/);
    expect(call, 'the create route calls resolveSpawnGrants').not.toBeNull();
    const args = call![1].split(',').map(a => a.trim()).filter(Boolean);
    // Position matters: `defaults` is the FIFTH parameter, and a constant handed to the fourth
    // would be read as a tools policy.
    expect(args[4]).toBe('DASHBOARD_CREATE_DEFAULT_GRANTS');
  });

  it('⚠ NO BACKFILL — the constant has exactly one production consumer', () => {
    const consumers: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__') walk(p); continue; }
        if (!e.name.endsWith('.ts') || /\.(?:test|spec)\.ts$/.test(e.name)) continue;
        if (p === path.join(SERVER_SRC, 'agent/access/create-defaults.ts')) continue; // the declaration
        if (/\bDASHBOARD_CREATE_DEFAULT_GRANTS\b/.test(stripComments(fs.readFileSync(p, 'utf-8')))) {
          consumers.push(path.relative(SERVER_SRC, p));
        }
      }
    };
    walk(SERVER_SRC);
    // One door moved. A second consumer — a boot sweep, a migration, a purge path — would be a
    // change to agents the owner has already read the panel for, and he has not ordered one.
    expect(consumers).toEqual(['gateway/routes/agents.ts']);
  });

  it('⚠ a granter without the category still gets a CREATE, clamped — never a refusal', () => {
    const narrow = cloneGrants(MOST_RESTRICTIVE_GRANTS); // holds the floor, not recall
    const out = resolveSpawnGrants(undefined, narrow, true, undefined, DASHBOARD_CREATE_DEFAULT_GRANTS);
    expect(out.ok).toBe(true);
    expect(out.ok && categoryGranted(out.grants, RECALL)).toBe(false);
  });
});
