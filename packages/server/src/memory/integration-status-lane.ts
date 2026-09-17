// ════════════════════════════════════════════════════════════════════════════════════════
// THE LIVE INTEGRATION-STATUS LINE — EVIDENCE OVER MEMORY, MADE STRUCTURAL. T76b (W85).
//
// ── THE INCIDENT (W84, 2026-09-16) ──────────────────────────────────────────────────────
// A regex in `plaud/tools-read.ts` never matched a single row the Plaud CLI printed, so
// `plaud_recent_recordings` answered `No recordings found.` over an account holding 23
// recordings. The tool did not fail — it LIED, in a confident sentence — and the cost was a
// day. What made it a day rather than a minute is recorded in W84 §5: during the diagnosis
// the agent concluded from that sentence that "Plaud flaps" and WROTE THAT INTO ITS VAULT.
// A false memory about a connection is self-sealing: the next turn recalls it, declines to
// call the tool, and reports the remembered breakage as current fact. The vault entry was
// deleted by hand (`c5db6b5e-…`), which fixes one row and not the mechanism.
//
// ── THE OWNER'S RULING, WHICH IS THIS FILE'S WHOLE CHARTER ──────────────────────────────
// The agent must never have to trust a notebook entry saying a connection is broken. The
// PLATFORM'S LIVE TRUTH sits in front of it every turn and OUTRANKS memory. Same shape HL5
// gave open commitments (`recall-lane.ts`): publish the complete current set, say out loud
// that it supersedes every earlier mention, and the recalled claim stops being the only
// thing in the room.
//
// ── LEDGER-BACKED ONLY, AND THE CENSUS THAT BOUNDS IT ───────────────────────────────────
// A status line that invents a freshness is the W84 defect one surface over, so every term
// below names a real reader and nothing else is said. The census (T76b Step 0, run against
// the worn-in dev body at `~/.dojo/data/dojo.db`):
//
//   TERM              SOURCE, and what it actually holds
//   state             `listIntegrationStatuses()` (`services/capability-registry.ts`), which
//                     reads `isGoogleConnected`/`isMicrosoftConnected` per account slot and
//                     `getPlaudStatus()`. Plaud's flag is an EPISODE LATCH, not a cache: the
//                     first failing call flips `plaud_connected` false (`plaud/auth.ts`, T38),
//                     so "connected" here means no call has failed it since the reconnect.
//   last success      `google_activity` / `microsoft_activity` — `MAX(created_at)` where
//                     `success = 1`, scoped to THIS agent. 16,820 and 16,555 rows on the dev
//                     body, written by `google/activity-log.ts` / `microsoft/activity-log.ts`.
//                     SCOPED TO THE AGENT FOR TWO REASONS, both measured: this block exists to
//                     contradict a claim THE AGENT remembers making, and 16,432 of those rows
//                     are `agent_id='system'` inbox polls firing on a timer — an unscoped MAX
//                     would tick every 30 seconds and churn the tail with nothing the agent
//                     did having changed. Agent-scoped on the dev body: kevin 146 google / 34
//                     microsoft. COVERAGE IS PARTIAL AND THE ERROR IS ONE-WAY: not every tool
//                     logs a row, so this stamp can be OLDER than the true last call, never
//                     newer. Understating freshness is safe here; overstating it is W84.
//                     PLAUD HAS NO SUCH TABLE. No plaud row exists in `tool_receipts` (that
//                     table is send-class only: `send_to_agent`, `imessage_send`,
//                     `gmail_reply`, `gmail_send`), and `audit_log` action_type='tool_call'
//                     names only the handful of tools that call `auditLog()` by hand. So the
//                     Plaud line states NO last use, and the block's footer says why — an
//                     absence of records, never a record of failure.
//   last failure      `agent_tool_failures` (mig 067). Per agent, per canonical signature,
//                     with `tool_name`, `last_at` and `hit_count` — and A SUCCESS DELETES THE
//                     ROW (`agent/v2/attempt-record.ts:35`). That deletion is what makes the
//                     term worth printing: a row present means a failure that has NOT since
//                     succeeded, and NO ROW means the ledger holds nothing unresolved. The
//                     second reading is the one that contradicts "Plaud is unreliable", and
//                     it is available for a family with no success ledger at all.
//   connected since   Plaud only: `plaud_connected_at` in `config`, via `getPlaudStatus()`.
//                     Rendered ONLY when no last-success term exists, so it is the fallback
//                     recency fact rather than a second one competing with it.
//
// ONE CANDIDATE WAS CENSUSED AND REJECTED, because rejecting it quietly is how the next task
// re-adds it. `google_accounts.last_verified_at` / `microsoft_accounts.last_verified_at` look
// like the Workspace twin of `plaud_connected_at` and are not: they are rewritten by the
// BACKGROUND TOKEN REFRESH, not by anything the agent did. Read off the dev body they carried
// `2026-09-17T05:26:49.561Z` and moved again on the next poll — a value that advances on a
// timer, which is the wall-clock-shaped churn T69b spent a whole task deleting from the tail.
// `plaud_connected_at` is written once, at connect, and is a genuine recorded instant.
//
// Nothing here reads a wall clock. Every instant is `recordedInstant(...)` — T69b's rule,
// unchanged: a block that is a function of `Date.now()` cannot be asserted about and re-bills
// the tail on a bucket boundary with nothing in the world having moved.
//
// ── ONLY WHAT THE AGENT MAY ACTUALLY TOUCH ──────────────────────────────────────────────
// The line is grant-scoped, because a status line that advertises an integration the agent
// cannot call teaches it to promise work it will be refused for — the exact drift
// `toolCategoryGranted` exists to stop between "advertised" and "permitted" (`access/read.ts`
// §ONE PREDICATE, TWO LAYERS). The grant readers are the same ones `agent/tools/surface.ts`
// filters the toolset with: `mayUsePlaud(agentId)` and `widestIntegrationLevel(agentId, …)`.
// NOT `getAgentGoogleAccessLevel`, which folds connectivity INTO the grant and answers
// 'none' for a disconnected provider — this block has to say "granted AND disconnected"
// out loud, and a reader that cannot distinguish the two cannot say it.
//
// ── WHAT THIS DOES NOT REPLACE ──────────────────────────────────────────────────────────
// `renderIntegrationReconnect` (`prompt/assembler.ts`, Inv I) already breadcrumbs a
// configured-but-disconnected family inside `msg.turn-context`. UNTOUCHED, and a different
// job: REMEDIATION-voiced (what to tell the user, plus the local-Office carve-out), PM-gated,
// and blind to both grants and ledgers. The overlap is one word (`disconnected`); folding the
// two together would rewrite turn-context, a behaviour change nobody asked for. Residual,
// recorded rather than taken.
//
// POSITION — 1877, the last seat in the stable group. Argued where it is decided:
// `prompt/registry/types.ts` (MessageSlot.IntegrationStatusTail) and the injection site in
// `agent/v2/steps/call-llm/pre-call-injections.ts`.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { TOOL_CATEGORIES } from '../tools/categories.js';
import { recordedInstant } from './message-stamp.js';
import { estimateTokens } from './budget.js';
import { laneLimit, truncateWrappedText } from './lanes.js';

/** The lane's own id (the reserve) and the registry entry that rides it. */
export const INTEGRATION_STATUS_LANE_ID = 'lane.integration-status';
export const INTEGRATION_STATUS_ENTRY_ID = 'msg.integration-status';

/** The integration families this block can speak about — the registry's own union. */
export type IntegrationFamily = 'google' | 'microsoft' | 'plaud';

/** The last failure the ledger STILL HOLDS for a family (a success deletes the row). */
export interface UnresolvedFailure {
  tool: string;
  /** `agent_tool_failures.last_at`, rendered as a recorded instant by the row builder. */
  lastAt: string;
  hits: number;
}

/**
 * One integration's row, shaped so the worst-case generator can fabricate a maximal block
 * without a database — the `work-board-lane.ts` / `recall-lane.ts` discipline.
 */
export interface IntegrationStatusRow {
  family: IntegrationFamily;
  /** What the owner calls it in the dashboard. */
  displayName: string;
  connected: boolean;
  /** `MAX(created_at)` over the family's success ledger for THIS agent; null when the
   *  platform keeps no such ledger, or keeps one and it is empty for this agent. */
  lastSuccessAt: string | number | null;
  /** Rendered ONLY when `lastSuccessAt` is null. Plaud's `plaud_connected_at` today. */
  connectedSince: string | number | null;
  /** Null means the ledger holds NOTHING unresolved — which is itself a printed fact. */
  unresolved: UnresolvedFailure | null;
  /** False when the platform records no per-call outcome ledger for this family at all.
   *  Drives the footer, so "no last use" is never read as "it stopped working". */
  hasSuccessLedger: boolean;
}

export const INTEGRATION_STATUS_HEAD = '═══ YOUR CONNECTED INTEGRATIONS — LIVE PLATFORM STATUS ═══';
export const INTEGRATION_STATUS_TAIL = '═══ END INTEGRATION STATUS ═══';

/**
 * THE SUPERSESSION PREAMBLE, in HL5's voice and for HL5's reason.
 *
 * `SNAPSHOT_SUPERSEDES` (`recall-lane.ts`) had to name the surfaces it outranks — summaries,
 * recalled memory, earlier in the conversation — because naming them is what stops the model
 * treating the published set as one more opinion. This one names the same three and adds the
 * one W84 actually died on: the agent's OWN SAVED NOTE. The incident's vault entry said Plaud
 * "flaps"; it arrived through `msg.relevant-memory`, which sits directly behind this block.
 */
export const INTEGRATION_STATUS_SUPERSEDES =
  'These lines are the CURRENT truth about your connections and they outrank any remembered '
  + 'claim about whether an integration works — in summaries, in recalled memory, in notes you '
  + 'saved yourself, and earlier in this conversation. A note saying a tool is broken, '
  + 'unreliable or returns nothing is a MEMORY of one past call; the states below are read from '
  + 'the platform\'s own records on this turn. Where the two disagree, this block is right: call '
  + 'the tool and answer from what it returns, not from what you remember about it.';

/**
 * The footer, emitted only when some row has no last-use term.
 *
 * It exists because silence is exactly how W84 got expensive. `No recordings found.` was an
 * absence of parsed rows rendered as a confident claim; a blank where a last use would go is
 * the same shape, and a model that reads it as "so it has never worked" has been taught the
 * defect by the block meant to cure it.
 */
export const INTEGRATION_STATUS_NO_LEDGER_NOTE =
  'Where no last successful use is shown, the platform keeps no per-call success ledger for '
  + 'that integration. That is an absence of RECORDS, not a record of failure — it says nothing '
  + 'about whether the tool works, so find out by calling it.';

/** A family with no unresolved failure says so, because that is the sentence a false "it is
 *  broken" memory has to be measured against. */
const NO_UNRESOLVED_FAILURE = 'No unresolved tool failure on record.';

/** One row, exactly the terms the ledger holds and no others. Pure. */
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
    // No false reassurance, and no reconnect advice either — `renderIntegrationReconnect`
    // owns that sentence inside `msg.turn-context` and two copies would be two truths.
    parts.push('DISCONNECTED. Its tools are not in your toolset this turn.');
  }
  if (r.lastSuccessAt !== null) parts.push(`Last successful use ${recordedInstant(r.lastSuccessAt)}.`);
  if (r.unresolved) {
    const tool = r.unresolved.tool.length > toolCap
      ? `${r.unresolved.tool.slice(0, toolCap)}...` : r.unresolved.tool;
    parts.push(
      `UNRESOLVED FAILURE: ${tool}, last failed ${recordedInstant(r.unresolved.lastAt)} `
      + `after ${r.unresolved.hits} attempt${r.unresolved.hits === 1 ? '' : 's'}, with no success since.`,
    );
  } else {
    parts.push(NO_UNRESOLVED_FAILURE);
  }
  return `• ${r.displayName} — ${parts.join(' ')}`;
}

/** The block, from rows already built. Pure — the worst-case generator calls this one. */
export function renderIntegrationStatusBlock(rows: IntegrationStatusRow[]): string | null {
  if (rows.length === 0) return null;
  const lines = rows.map(integrationStatusLine);
  const footer = rows.some((r) => !r.hasSuccessLedger || r.lastSuccessAt === null)
    ? `\n${INTEGRATION_STATUS_NO_LEDGER_NOTE}`
    : '';
  return `${INTEGRATION_STATUS_HEAD}\n${INTEGRATION_STATUS_SUPERSEDES}\n${lines.join('\n')}${footer}\n${INTEGRATION_STATUS_TAIL}`;
}

/** Display names, the owner's own words for these three (the reconnect breadcrumb's map). */
const DISPLAY_NAME: Record<IntegrationFamily, string> = {
  google: 'Google Workspace',
  microsoft: 'Microsoft 365',
  plaud: 'Plaud',
};

/**
 * THE FAMILY A TOOL NAME BELONGS TO — tool NAMES read out of `TOOL_CATEGORIES`; only the
 * LABEL → family assignment is written here.
 *
 * WHY THE CATEGORY TABLE AND NOT THE DEFINITION ARRAYS. The obvious source is
 * `googleReadToolDefinitions` & friends — each array IS a family. It was built that way first
 * and MEASURED: importing those seven modules drags in the whole provider world (`googleapis`,
 * and through the media tools `phonemizer` with its espeak data blob). This runs on the
 * assembly path of every turn. `tools/categories.ts` carries the same names behind ONE
 * type-only import, is already the door `access/read.ts` reads for `toolCategoryGranted`, and
 * is the table an owner actually edits when a tool is added.
 *
 * WHY IT CANNOT ROT SILENTLY. What is typed is not tool names but LABELS — every one of the
 * category table's, including those that are deliberately NOT an integration family. A new
 * label with no row here fails `the-status-line-beats-the-note.test.ts` §1 instead of quietly
 * dropping a family's failures. Against the prefix list it replaces, that is the whole
 * difference: an omission is loud.
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

/**
 * Category labels that are NOT one of the three families, listed so the census is COMPLETE
 * and an unclassified label is a test failure rather than a silent drop.
 *
 * The first two are the ones that could plausibly have been attributed and must not be:
 * 'Office Documents' runs on THIS MACHINE with no Microsoft account (the local carve-out
 * `renderIntegrationReconnect` declares, battery scenario document-creation-office
 * 2026-07-06), so a failure there is no evidence about the Graph connection; 'Unified
 * Search' is `email_search`, which spans every connected mailbox at once and so cannot be
 * charged to Google OR Microsoft without guessing.
 */
const NOT_AN_INTEGRATION: ReadonlySet<string> = new Set([
  'Office Documents', 'Unified Search (all connected accounts at once)',
  'Twilio (SMS + Voice phone calls)', 'Meta', 'File & System', 'Web',
  'Shared Workspace (right dock)', 'Media Generation (image / video / music / speech)', 'PDF',
  'DOJO Contacts (people the owner interacts with - persistent, agent-authored)',
  'Agent Credentials (encrypted API keys / tokens the agent uses to call services)',
  'Vault (Long-Term Memory)', 'Conversation Recall', 'Open Work (what you still owe)',
  'Squad Coordination', 'Work Tracker (projects, tasks, reminders, promises)',
  'Managing Other Agents', 'Techniques', 'Communication',
  "DOJO Controls (change settings / navigate the dashboard on the owner's behalf)",
  'Oversight & Admin', 'Healer (self-repair)', 'Tunnel (Remote Access)',
]);

/** Exported so the gate can assert the census is COMPLETE against the live category table.
 *  `undefined` means UNCLASSIFIED — neither a family nor declared irrelevant — which is the
 *  only answer this module treats as a defect. */
export function integrationFamilyForLabel(label: string): IntegrationFamily | null | undefined {
  return LABEL_FAMILY[label] ?? (NOT_AN_INTEGRATION.has(label) ? null : undefined);
}

let familyIndex: Map<string, IntegrationFamily> | null = null;

function toolFamilyIndex(): Map<string, IntegrationFamily> {
  if (familyIndex) return familyIndex;
  const index = new Map<string, IntegrationFamily>();
  for (const category of TOOL_CATEGORIES) {
    const family = LABEL_FAMILY[category.label];
    if (!family) continue;
    for (const tool of category.tools) {
      index.set(tool, family);
      // The `user_` twins are generated from the same names at the surface (`surface.ts`
      // strips the prefix before asking its service gate), so a failure recorded against
      // `user_gmail_search` belongs to the family its canonical does.
      index.set(`user_${tool}`, family);
    }
  }
  familyIndex = index;
  return familyIndex;
}

/** Test seam — the index is derived from a module constant, so forgetting is always safe. */
export function forgetToolFamilyIndex(): void {
  familyIndex = null;
}

/**
 * The unresolved failure each family still carries for this agent, newest first.
 *
 * One read of `agent_tool_failures` for the agent, bucketed here. Reading per family would
 * be three queries for one index scan, and the table's PK is (agent_id, signature).
 */
function unresolvedByFamily(agentId: string): Map<IntegrationFamily, UnresolvedFailure> {
  const out = new Map<IntegrationFamily, UnresolvedFailure>();
  try {
    const index = toolFamilyIndex();
    const rows = getDb().prepare(
      'SELECT tool_name, last_at, hit_count FROM agent_tool_failures WHERE agent_id = ? ORDER BY last_at DESC',
    ).all(agentId) as Array<{ tool_name: string; last_at: string; hit_count: number }>;
    for (const row of rows) {
      const family = index.get(row.tool_name);
      if (!family || out.has(family)) continue;   // ORDER BY means the first seen is newest
      out.set(family, { tool: row.tool_name, lastAt: row.last_at, hits: row.hit_count });
    }
  } catch { /* the table may not exist on an old DB — the row then prints no failure term */ }
  return out;
}

/**
 * The last SUCCESSFUL call this agent made on a Workspace provider.
 *
 * `google_activity` / `microsoft_activity` are written by `google/activity-log.ts` and
 * `microsoft/activity-log.ts` on every API call, with `success INTEGER` and `error TEXT`.
 * Scoped to the agent on purpose: this block exists to contradict a claim the AGENT
 * remembers making, and "someone else's call worked" is a weaker sentence than "yours did".
 */
function lastSuccessAt(agentId: string, table: 'google_activity' | 'microsoft_activity'): string | null {
  try {
    const row = getDb().prepare(
      `SELECT MAX(created_at) AS at FROM ${table} WHERE agent_id = ? AND success = 1`,
    ).get(agentId) as { at: string | null } | undefined;
    return row?.at ?? null;
  } catch { return null; }
}

/**
 * The block for this agent, or null when it holds no configured, granted integration.
 *
 * Async and dynamically imported, like `buildWorkBoardLane`: the connection and grant readers
 * sit under `google/`, `microsoft/`, `plaud/` and `agent/access/`, all of which are upstream
 * of nothing in `memory/` today and should stay that way.
 */
export async function buildIntegrationStatusLane(agentId: string): Promise<string | null> {
  let rows: IntegrationStatusRow[];
  try {
    const [{ listIntegrationStatuses }, { mayUsePlaud, widestIntegrationLevel }, { getPlaudStatus }] =
      await Promise.all([
        import('../services/capability-registry.js'),
        import('../agent/access/read.js'),
        import('../plaud/auth.js'),
      ]);
    const failures = unresolvedByFamily(agentId);
    // Sorted by family name so the block is byte-deterministic regardless of the registry's
    // iteration order — C28 P-6's rule, which this block needs for the same reason.
    const statuses = [...listIntegrationStatuses()].sort((a, b) => a.name.localeCompare(b.name));
    rows = [];
    for (const s of statuses) {
      // CONFIGURED is the gate, not CONNECTED: a family the owner never set up has no truth
      // to publish, while one that is set up and currently down is precisely what a false
      // memory forms around. The disconnected row is the negative control, not an omission.
      if (!s.configured) continue;
      if (s.name === 'plaud') {
        if (!mayUsePlaud(agentId)) continue;
        const plaud = getPlaudStatus();
        rows.push({
          family: 'plaud',
          displayName: DISPLAY_NAME.plaud,
          connected: s.connected,
          lastSuccessAt: null,           // no ledger exists; see the census in this file's head
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
  } catch {
    return null;   // a reader that cannot answer says nothing; it never guesses a state
  }
  return enforce(renderIntegrationStatusBlock(rows), integrationStatusWorstCaseTokens());
}

/** A post-budget lane may not exceed the reserve it declared — `work-board-lane.ts`'s rule,
 *  applied at the render because no allocator runs downstream of a post-budget lane. */
function enforce(block: string | null, maxTokens: number): string | null {
  if (!block) return null;
  return estimateTokens(block) > maxTokens ? truncateWrappedText(block, maxTokens) : block;
}

// ── THE DECLARED RESERVE, DERIVED BY CALLING THE RENDERER ───────────────────────────────
//
// `lanes.ts`'s `PostBudgetLane.measured` says a reserve with no derivation is a rumour. The
// number is produced by feeding the REAL renderer a maximal block — every declared cap
// flooded at once, every optional term present on every row — so a cap that changes moves the
// reserve with it, and `the-status-line-beats-the-note.test.ts` pins the literal to this
// function.

let worstCase: number | null = null;

export function integrationStatusWorstCaseTokens(): number {
  if (worstCase !== null) return worstCase;
  const rowCap = laneLimit(INTEGRATION_STATUS_LANE_ID, 'rows', 'integrations');
  const toolCap = laneLimit(INTEGRATION_STATUS_LANE_ID, 'chars', 'tool');
  // The widest instant `recordedInstant` can return is its own fallback or a full stamp;
  // both are produced by CALLING it rather than counted beside it.
  const widestInstantSource = '2026-09-30T23:41:59.999Z';
  const rows: IntegrationStatusRow[] = [];
  const widestName = Object.values(DISPLAY_NAME)
    .reduce((a, b) => (a.length >= b.length ? a : b));
  for (let i = 0; i < rowCap; i++) {
    rows.push({
      family: 'google',
      displayName: widestName,
      // DISCONNECTED is the longer of the two state clauses, and `connectedSince` is only
      // rendered when `lastSuccessAt` is null — so the maximal row takes the longer state
      // clause AND the last-success term, which is the widest combination the renderer emits.
      connected: false,
      lastSuccessAt: widestInstantSource,
      connectedSince: widestInstantSource,
      unresolved: { tool: 't'.repeat(toolCap + 10), lastAt: widestInstantSource, hits: 999_999 },
      hasSuccessLedger: true,
    });
  }
  // One extra row in the "no ledger" shape so the FOOTER is inside the measurement.
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
