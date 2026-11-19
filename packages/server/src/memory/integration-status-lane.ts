// The live integration-status line: the platform's own record of each connection, shown to the agent every
// turn and outranking any remembered claim that an integration is broken (a false note about one persists).
// Ledger-backed only: every term below names a real reader and nothing else is said.
//   state: `listIntegrationStatuses()`; Plaud's flag is an episode latch (the first failing call flips it).
//   last success: `MAX(created_at)` of `google_activity` / `microsoft_activity` (success = 1), this agent
//   only (system polls on a timer would tick it). Coverage is partial: the stamp can be older than the
//   true last call, never newer. Plaud has no such ledger: its line has no last use; the footer says why.
//   last failure: `agent_tool_outcomes` (`agent/v2/tool-outcomes.ts`), per tool; a later success ends it.
//   connected since: Plaud only (`plaud_connected_at`), rendered only when no last-success term exists.
// `last_verified_at` on the account tables is not used: the background token refresh rewrites it on a timer.
// Nothing reads a wall clock: every instant is `recordedInstant(...)`, so the block never re-bills the tail.
// Grant-scoped via `mayUsePlaud` and `widestIntegrationLevel`, not `getAgentGoogleAccessLevel`, which folds
// connectivity into the grant and so cannot say "granted AND disconnected".

import { getDb } from '../db/connection.js';
import { isOpenFailure, readToolOutcomes } from '../agent/v2/tool-outcomes.js';
import { TOOL_CATEGORIES } from '../tools/categories.js';
import { recordedInstant } from './message-stamp.js';
import { estimateTokens } from './budget.js';
import { sessionBoundaryText } from './session-boundary.js';
import { laneLimit, truncateWrappedText } from './lanes.js';

export const INTEGRATION_STATUS_LANE_ID = 'lane.integration-status';

export type IntegrationFamily = 'google' | 'microsoft' | 'plaud';

export interface UnresolvedFailure {
  tool: string;
  lastAt: string;
  hits: number;   // failures in a row since that tool last succeeded (at least 1)
  /** Whose account the tool acts on: the owner's (`user_` twins) or the agent's own. */
  account?: 'agent' | 'owner';
}

export interface IntegrationStatusRow {
  family: IntegrationFamily;
  displayName: string;
  connected: boolean;
  /** Latest success for this agent; null when there is no ledger or it is empty. */
  lastSuccessAt: string | number | null;
  connectedSince: string | number | null;
  unresolved: UnresolvedFailure | null;
  hasSuccessLedger: boolean;
}

export const INTEGRATION_STATUS_HEAD = '═══ YOUR CONNECTED INTEGRATIONS — LIVE PLATFORM STATUS ═══';
export const INTEGRATION_STATUS_TAIL = '═══ END INTEGRATION STATUS ═══';

/** Names the surfaces it outranks, as `SNAPSHOT_SUPERSEDES` in `recall-lane.ts` does, plus saved notes. */
export const INTEGRATION_STATUS_SUPERSEDES =
  'These lines are the CURRENT truth about your connections and they outrank any remembered '
  + 'claim about whether an integration works — in summaries, in recalled memory, in notes you '
  + 'saved yourself, and earlier in this conversation. A note saying a tool is broken, '
  + 'unreliable or returns nothing is a MEMORY of one past call; the states below are read from '
  + 'the platform\'s own records on this turn. Where the two disagree, this block is right: call '
  + 'the tool and answer from what it returns, not from what you remember about it.';

/** Footer when some row has no last-use term: an absence of records is not a record of failure. */
export const INTEGRATION_STATUS_NO_LEDGER_NOTE =
  'Where no last successful use is shown, the platform keeps no per-call success ledger for '
  + 'that integration. That is an absence of RECORDS, not a record of failure — it says nothing '
  + 'about whether the tool works, so find out by calling it.';

const NO_UNRESOLVED_FAILURE = 'No unresolved tool failure on record.';

export function integrationStatusLine(r: IntegrationStatusRow): string {
  const toolCap = laneLimit(INTEGRATION_STATUS_LANE_ID, 'chars', 'tool');
  const parts: string[] = [];
  if (r.connected) {
    parts.push(
      r.lastSuccessAt === null && r.connectedSince !== null
        ? `CONNECTED since ${recordedInstant(r.connectedSince)}.`
        : 'CONNECTED.',
    );
  } else {
    // No reconnect advice: `renderIntegrationReconnect` owns that sentence in `msg.turn-context`.
    parts.push('DISCONNECTED. Its tools are not in your toolset this turn.');
  }
  if (r.lastSuccessAt !== null) parts.push(`Last successful use ${recordedInstant(r.lastSuccessAt)}.`);
  if (r.unresolved) {
    const tool = r.unresolved.tool.length > toolCap
      ? `${r.unresolved.tool.slice(0, toolCap)}...` : r.unresolved.tool;
    const account = r.unresolved.account === 'owner' ? "the owner's account" : "the agent's own account";
    parts.push(
      `UNRESOLVED FAILURE on ${account}: ${tool}, last failed ${recordedInstant(r.unresolved.lastAt)}, `
      + `${r.unresolved.hits} in a row, with no later call of that account's tools in this family.`,
    );
  } else {
    parts.push(NO_UNRESOLVED_FAILURE);
  }
  return `• ${r.displayName} — ${parts.join(' ')}`;
}

export function renderIntegrationStatusBlock(rows: IntegrationStatusRow[]): string | null {
  if (rows.length === 0) return null;
  const lines = rows.map(integrationStatusLine);
  const footer = rows.some((r) => !r.hasSuccessLedger || r.lastSuccessAt === null)
    ? `\n${INTEGRATION_STATUS_NO_LEDGER_NOTE}`
    : '';
  return `${INTEGRATION_STATUS_HEAD}\n${INTEGRATION_STATUS_SUPERSEDES}\n${lines.join('\n')}${footer}\n${INTEGRATION_STATUS_TAIL}`;
}

const DISPLAY_NAME: Record<IntegrationFamily, string> = {
  google: 'Google Workspace',
  microsoft: 'Microsoft 365',
  plaud: 'Plaud',
};

/**
 * Tool name to family, read from `TOOL_CATEGORIES` (the definition arrays would import the provider SDKs
 * on every turn). A label absent from this table has no family, so its tools are not indexed.
 */
const LABEL_FAMILY: Record<string, IntegrationFamily> = {
  'Gmail': 'google',
  'Google Calendar': 'google',
  'Google Drive / Docs / Sheets': 'google',
  'Google Tasks': 'google',
  'Google Slides': 'google',
  'Google Forms': 'google',
  'Outlook': 'microsoft',
  'Microsoft Contacts (read-only escape hatch into the Microsoft directory)': 'microsoft',
  'Microsoft Calendar': 'microsoft',
  'OneDrive': 'microsoft',
  'OneNote': 'microsoft',
  'SharePoint': 'microsoft',
  'Teams Online Meetings': 'microsoft',
  'Microsoft Teams': 'microsoft',
  'Plaud (voice recorder integration)': 'plaud',
};

let familyIndex: Map<string, IntegrationFamily> | null = null;

function toolFamilyIndex(): Map<string, IntegrationFamily> {
  if (familyIndex) return familyIndex;
  const index = new Map<string, IntegrationFamily>();
  for (const category of TOOL_CATEGORIES) {
    const family = LABEL_FAMILY[category.label];
    if (!family) continue;
    for (const tool of category.tools) {
      index.set(tool, family);
      index.set(`user_${tool}`, family);
    }
  }
  familyIndex = index;
  return familyIndex;
}

// A technique's families: those of the tool names its text names, plus a tag naming a family.
let toolNamePattern: RegExp | null = null;
const FAMILY_NAMES: readonly IntegrationFamily[] = ['google', 'microsoft', 'plaud'];

export function techniqueFamilies(text: string | null | undefined, tags: readonly string[] = []): Set<IntegrationFamily> {
  const index = toolFamilyIndex();
  const out = new Set<IntegrationFamily>();
  for (const t of tags) if ((FAMILY_NAMES as readonly string[]).includes(t.toLowerCase())) out.add(t.toLowerCase() as IntegrationFamily);
  if (!text) return out;
  if (!toolNamePattern) {
    const names = [...index.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/[^a-z0-9_]/gi, ''));
    toolNamePattern = new RegExp(`\\b(${names.join('|')})\\b`, 'g');
  }
  for (const m of text.matchAll(toolNamePattern)) {
    const family = index.get(m[1]);
    if (family) out.add(family);
  }
  return out;
}

export async function usableIntegrationFamilies(agentId: string): Promise<Set<IntegrationFamily>> {
  try {
    return new Set((await integrationRows(agentId)).filter((r) => r.connected).map((r) => r.family));
  } catch {
    return new Set();
  }
}

/**
 * The open failure each family carries for this agent, per family and account (the agent's own tools or
 * the owner's `user_` twins). Only the newest outcome counts: a later success of any tool on that account
 * clears it, and one from before the session boundary is history. `readToolOutcomes` is newest-first.
 */
function unresolvedByFamily(agentId: string): Map<IntegrationFamily, UnresolvedFailure> {
  const out = new Map<IntegrationFamily, UnresolvedFailure>(), index = toolFamilyIndex();
  const boundary = sessionBoundaryText(agentId);
  const seen = new Set<string>();
  for (const o of readToolOutcomes(agentId)) {
    const family = index.get(o.toolName);
    if (!family) continue;
    const account: 'agent' | 'owner' = o.toolName.startsWith('user_') ? 'owner' : 'agent';
    const key = `${family}|${account}`;
    if (seen.has(key)) continue;   // an older outcome on an account whose newest is already read
    seen.add(key);
    if (!isOpenFailure(o) || !o.lastFailAt) continue;
    if (boundary && o.lastFailAt < boundary) continue;   // before this session: history, not status
    const prior = out.get(family);
    if (!prior || o.lastFailAt > prior.lastAt) out.set(family, { tool: o.toolName, lastAt: o.lastFailAt, hits: o.consecutiveFailures, account });
  }
  return out;
}

function lastSuccessAt(agentId: string, table: 'google_activity' | 'microsoft_activity'): string | null {
  try {
    const row = getDb().prepare(
      `SELECT MAX(created_at) AS at FROM ${table} WHERE agent_id = ? AND success = 1`,
    ).get(agentId) as { at: string | null } | undefined;
    return row?.at ?? null;
  } catch { return null; }
}

/**
 * The block for this agent, or null. The readers are imported dynamically so `memory/` does not depend on
 * `google/`, `microsoft/`, `plaud/` or `agent/access/`.
 */
export async function buildIntegrationStatusLane(agentId: string): Promise<string | null> {
  try {
    return enforce(renderIntegrationStatusBlock(await integrationRows(agentId)), integrationStatusWorstCaseTokens());
  } catch {
    return null;   // a reader that cannot answer says nothing; it never guesses a state
  }
}

async function integrationRows(agentId: string): Promise<IntegrationStatusRow[]> {
  const rows: IntegrationStatusRow[] = [];
  const [{ listIntegrationStatuses }, { mayUsePlaud, widestIntegrationLevel }, { getPlaudStatus }] =
    await Promise.all([
      import('../services/capability-registry.js'),
      import('../agent/access/read.js'),
      import('../plaud/auth.js'),
    ]);
  const failures = unresolvedByFamily(agentId);
  // Sorted by family name so the block is byte-deterministic.
  const statuses = [...listIntegrationStatuses()].sort((a, b) => a.name.localeCompare(b.name));
  for (const s of statuses) {
    // Gate on configured, not connected: a configured family that is down is where a false memory forms.
    if (!s.configured) continue;
    if (s.name === 'plaud') {
      if (!mayUsePlaud(agentId)) continue;
      const plaud = getPlaudStatus();
      rows.push({
        family: 'plaud',
        displayName: DISPLAY_NAME.plaud,
        connected: s.connected,
        lastSuccessAt: null,           // no ledger exists
        connectedSince: plaud.connectedAt,
        unresolved: failures.get('plaud') ?? null,
        hasSuccessLedger: false,
      });
      continue;
    }
    if (widestIntegrationLevel(agentId, s.name) === 'none') continue;
    rows.push({
      family: s.name,
      displayName: DISPLAY_NAME[s.name],
      connected: s.connected,
      lastSuccessAt: lastSuccessAt(agentId, s.name === 'google' ? 'google_activity' : 'microsoft_activity'),
      connectedSince: null,
      unresolved: failures.get(s.name) ?? null,
      hasSuccessLedger: true,
    });
  }
  return rows;
}

/** Holds the block to its declared reserve here, because no allocator runs after a post-budget lane. */
function enforce(block: string | null, maxTokens: number): string | null {
  if (!block) return null;
  return estimateTokens(block) > maxTokens ? truncateWrappedText(block, maxTokens) : block;
}

// The reserve is derived by rendering a maximal block (every cap flooded, every optional term present), so
// a cap change moves it; `the-status-line-beats-the-note.test.ts` pins the literal to this function.

let worstCase: number | null = null;

export function integrationStatusWorstCaseTokens(): number {
  if (worstCase !== null) return worstCase;
  const rowCap = laneLimit(INTEGRATION_STATUS_LANE_ID, 'rows', 'integrations');
  const toolCap = laneLimit(INTEGRATION_STATUS_LANE_ID, 'chars', 'tool');
  const widestInstantSource = '2026-09-30T23:41:59.999Z';
  const rows: IntegrationStatusRow[] = [];
  const widestName = Object.values(DISPLAY_NAME)
    .reduce((a, b) => (a.length >= b.length ? a : b));
  for (let i = 0; i < rowCap; i++) {
    rows.push({
      family: 'google',
      displayName: widestName,
      // DISCONNECTED is the longer state clause; with a last success set this is the widest row the renderer emits.
      connected: false,
      lastSuccessAt: widestInstantSource,
      connectedSince: widestInstantSource,
      unresolved: { tool: 't'.repeat(toolCap + 10), lastAt: widestInstantSource, hits: 999_999, account: 'agent' },   // "the agent's own account" is the longer phrase
      hasSuccessLedger: true,
    });
  }
  // One no-ledger row so the footer is inside the measurement.
  rows.push({
    family: 'plaud',
    displayName: widestName,
    connected: true,
    lastSuccessAt: null,
    connectedSince: widestInstantSource,
    unresolved: null,
    hasSuccessLedger: false,
  });
  worstCase = estimateTokens(renderIntegrationStatusBlock(rows) ?? '');
  return worstCase;
}
