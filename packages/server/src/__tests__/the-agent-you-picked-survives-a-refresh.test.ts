// ════════════════════════════════════════════════════════════════════════════════
// THE AGENT YOU PICKED SURVIVES A REFRESH (T78b) — RED-first.
//
// The owner's complaint, verbatim in shape: switch the dojo3 stage to a sub-agent,
// then reload the desktop tab — or leave the iPhone and come back — and the stage
// is talking to the primary again. The selection lived in ONE `useState` inside
// `ActiveAgentProvider` and nowhere else, so every mount started at the primary by
// construction.
//
// ── THE THREE THINGS THIS FILE PINS, AND WHY EACH IS A SEPARATE CLAUSE ──
//
//  1. THE MEMORY IS THE BROWSER'S, AND IT IS `localStorage`. Mobile Safari
//     discards a backgrounded page's process; `sessionStorage` dies with it and
//     the iPhone case — the one the owner actually hits — would still be broken
//     while the desktop case looked fixed. So the storage clause is not "it
//     persists", it is "it persists in the store that survives a discarded page",
//     and the negative half (no `sessionStorage` on this path) is asserted too.
//
//  2. A RESTORE IS A CLAIM, NOT A FACT. A stored id can name an agent that was
//     deleted, ended, or archived since the tab was last open — and on a box with
//     114 agents that is the normal case, not the exotic one. `isRestorable` is
//     the single predicate that decides, and it is asserted against the SHARED
//     `AGENT_STATUSES` list so a status added later cannot slip through
//     unclassified. Anything it refuses falls back to the primary silently: a
//     chat that can never answer is worse than the default one.
//
//  3. THE URL IS AN ENTRY POINT AND IT OUTRANKS THE STORE. `?agent=<id>` makes
//     the view linkable and back-button-sane, and when the two disagree the URL
//     wins — it is the user asking for that agent by name in this very request,
//     where the store is only what they did last time. ABSENCE of the param is
//     NOT a signal (most in-app navigations drop the query string), which is why
//     `restoreCandidate` falls through to the store rather than to null.
//
// RED AT `323bc1b2`, measured: `packages/dashboard/src/lib/active-agent-memory.ts`
// does not exist — every import below fails to resolve — and `ActiveAgentProvider.tsx`
// contains no `localStorage`, no `agent` query param, and one bare `useState<
// SelectedAgent | null>(null)` that is the whole of the selection's life.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENT_STATUSES } from '@dojo/shared';
import type { AgentStatus } from '@dojo/shared';
import {
  ACTIVE_AGENT_STORAGE_KEY,
  ACTIVE_AGENT_URL_PARAM,
  parseRemembered,
  serializeRemembered,
  agentParamOf,
  withAgentParam,
  isRestorable,
  restoreCandidate,
} from '../../../dashboard/src/lib/active-agent-memory.js';

const DASH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dashboard', 'src',
);
const readDash = (rel: string): string => fs.readFileSync(path.join(DASH, rel), 'utf8');

/** Source with every comment stripped, so a clause about what the CODE does can
 *  never be satisfied — or broken — by prose describing the old behaviour. */
const withoutComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the remembered agent', () => {
  it('round-trips id, name and hue through the store', () => {
    const raw = serializeRemembered({ id: 'agent-7', name: 'Scout', hue: 202 });
    expect(parseRemembered(raw)).toEqual({ id: 'agent-7', name: 'Scout', hue: 202 });
  });

  it('survives an agent with no chosen colour (hue is optional, not zero)', () => {
    const raw = serializeRemembered({ id: 'agent-7', name: 'Scout' });
    const back = parseRemembered(raw);
    expect(back?.id).toBe('agent-7');
    expect(back?.hue).toBeUndefined();
  });

  // Nothing here may throw: this runs during the very first render, and an
  // exception there is a white screen on every load until the user clears
  // their site data — a far worse bug than the one being fixed.
  it.each([
    ['nothing stored', null],
    ['empty string', ''],
    ['not JSON at all', '{oops'],
    ['JSON that is not an object', '"agent-7"'],
    ['an object with no id', '{"name":"Scout"}'],
    ['an object whose id is not a string', '{"id":42,"name":"Scout"}'],
    ['an object whose id is empty', '{"id":"","name":"Scout"}'],
    ['null', 'null'],
  ])('reads %s as no selection rather than throwing', (_label, raw) => {
    expect(() => parseRemembered(raw)).not.toThrow();
    expect(parseRemembered(raw)).toBeNull();
  });

  it('drops a name or hue of the wrong type instead of trusting them', () => {
    expect(parseRemembered('{"id":"a1","name":7,"hue":"blue"}')).toEqual({ id: 'a1', name: '', hue: undefined });
  });

  it('keys the store under one name that only the memory module spells', () => {
    expect(ACTIVE_AGENT_STORAGE_KEY).toBe('dojo_active_agent');
  });
});

describe('what a restore is allowed to land on', () => {
  const agent = (status: AgentStatus, agentType = 'standard') =>
    ({ status, agentType }) as Parameters<typeof isRestorable>[0];

  // The visibility rule is not invented here: it is the one the Agents page
  // already draws its "active" list with (`status !== 'terminated' &&
  // agentType !== 'archived'`). Restoring onto something the user cannot see
  // in the roster is the broken-empty-chat case with extra steps.
  it('refuses an agent that has ended', () => {
    expect(isRestorable(agent('terminated'))).toBe(false);
  });

  it('refuses an archived agent, whatever its status says', () => {
    expect(isRestorable(agent('idle', 'archived'))).toBe(false);
  });

  it('refuses nothing at all (a 404 from the server is not a selection)', () => {
    expect(isRestorable(null)).toBe(false);
    expect(isRestorable(undefined)).toBe(false);
  });

  it('accepts every other live status the platform can hold', () => {
    const live = AGENT_STATUSES.filter((s) => s !== 'terminated');
    expect(live.length).toBeGreaterThan(3);
    for (const s of live) expect(isRestorable(agent(s))).toBe(true);
  });

  // Census clause: every declared status is classified by this predicate, so a
  // status added to the platform later has to be thought about here.
  it('has an answer for every status the platform declares', () => {
    for (const s of AGENT_STATUSES) expect(typeof isRestorable(agent(s))).toBe('boolean');
  });
});

describe('the url carries the agent, and outranks the store', () => {
  it('names the param `agent`', () => {
    expect(ACTIVE_AGENT_URL_PARAM).toBe('agent');
  });

  it('reads the id out of a query string, blank or absent being no id', () => {
    expect(agentParamOf('?agent=a1')).toBe('a1');
    expect(agentParamOf('?tab=voice&agent=a1&section=x')).toBe('a1');
    expect(agentParamOf('?agent=')).toBeNull();
    expect(agentParamOf('?agent=%20')).toBeNull();
    expect(agentParamOf('?tab=voice')).toBeNull();
    expect(agentParamOf('')).toBeNull();
  });

  it('writes the id in WITHOUT trampling the params other pages own', () => {
    expect(withAgentParam('?tab=voice&section=wake', 'a1')).toBe('?tab=voice&section=wake&agent=a1');
    expect(withAgentParam('?agent=old&tab=voice', 'new')).toBe('?agent=new&tab=voice');
  });

  it('takes the id back out and leaves no naked question mark behind', () => {
    expect(withAgentParam('?agent=a1', null)).toBe('');
    expect(withAgentParam('?tab=voice&agent=a1', null)).toBe('?tab=voice');
    expect(withAgentParam('', null)).toBe('');
  });

  const stored = { id: 'stored-1', name: 'Scout', hue: 202 };

  it('prefers the url when the two disagree', () => {
    expect(restoreCandidate('?agent=from-url', stored)).toEqual({ id: 'from-url', name: '' });
  });

  it('keeps the stored name and hue when the url names the SAME agent', () => {
    expect(restoreCandidate('?agent=stored-1', stored)).toEqual(stored);
  });

  it('falls through to the store when the url says nothing — absence is not a signal', () => {
    expect(restoreCandidate('?tab=voice', stored)).toEqual(stored);
    expect(restoreCandidate('', stored)).toEqual(stored);
  });

  it('is no selection when neither has one', () => {
    expect(restoreCandidate('?tab=voice', null)).toBeNull();
  });
});

describe('the provider is wired to that memory and to nothing else', () => {
  const provider = readDash('components/ActiveAgentProvider.tsx');
  const code = withoutComments(provider);

  it('imports the memory module rather than hand-rolling a key', () => {
    expect(code).toMatch(/from '\.\.\/lib\/active-agent-memory'/);
    // The literal key appears in exactly one file in the dashboard: the module.
    expect(code).not.toContain('dojo_active_agent');
  });

  it('restores through `restoreCandidate` at mount, not after a render', () => {
    expect(code).toContain('restoreCandidate(');
    // A lazy initialiser, so the restored agent is on screen in the first
    // paint. An effect here would mean a visible flash of the primary.
    expect(code).toMatch(/useState<[^>]*>\(\s*\(\) =>/);
  });

  it('verifies the restored id against the server before trusting it', () => {
    expect(code).toContain('api.getAgent(');
    expect(code).toContain('isRestorable(');
  });

  // Comments stripped on both sides: the memory module's header ARGUES about
  // sessionStorage at length, and a clause about what the code CALLS must not
  // be broken by the prose explaining why it does not.
  it('never reaches for sessionStorage — the iPhone loses that one', () => {
    expect(code).not.toContain('sessionStorage');
    expect(withoutComments(readDash('lib/active-agent-memory.ts'))).not.toContain('sessionStorage');
  });

  it('keeps the url in step with the selection', () => {
    expect(code).toContain('withAgentParam(');
    expect(code).toMatch(/replace: true/);
  });

  it('writes the selection through on every change, not only at unload', () => {
    // No `beforeunload`/`pagehide` handler: mobile Safari is not guaranteed to
    // run one when it discards a tab, which is exactly the case that must work.
    expect(code).not.toContain('beforeunload');
    expect(code).toContain('rememberAgent(');
  });
});
