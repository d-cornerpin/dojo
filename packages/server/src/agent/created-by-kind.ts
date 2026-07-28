// ════════════════════════════════════════════════════════════════════════
// WHO MADE THIS ROW — one fact, one column, stamped once at creation.
//
// PHASE-1 T11 Step 1b (the K8 rider). `agents`, `tasks` and `projects` each carry
// `created_by_kind` (migration 134). It exists so that "this row belongs to the test
// harness and is disposable" stops being inferred from an agent's NAME.
//
// The harness's clean-slate sweep used to decide what it could delete with
// `name LIKE 'Behav%'`, which is wrong in both directions: a renamed fixture drops out
// of the sweep and leaves debris (the Phase-0 exit left three terminated `behavpeer-*`
// agents behind exactly that way), and a lived-in agent a person names "Behaviour
// review" falls INSIDE a test run's blast radius. Free text is not ownership.
//
// ── THE PROPAGATION RULE, and why it is not optional ──
// Measured on this box before this file was written:
//     SELECT created_by, COUNT(*) FROM legacy_tasks    GROUP BY 1  ->  BehaviorBot's id, 50
//     SELECT created_by, COUNT(*) FROM legacy_projects GROUP BY 1  ->  BehaviorBot's id, 102
// Almost every harness-owned task and project is created by the ENGINE on the harness
// agent's behalf — the auto-scaffolder, the PM, a tool call inside a scenario turn. The
// kit never touches those rows, so a column the kit alone stamped would be NULL on
// precisely the rows the sweep has to find, and switching the sweep to it would make the
// sweep see LESS than the name pattern did. So the kind travels with authorship: a row
// created BY an agent inherits that agent's kind, and a child agent inherits its
// parent's. One stamp at the top, and everything downstream of it is honest.
//
// ── NULL MEANS "NOT RECORDED", AND NOTHING ELSE ──
// Every row that predates migration 134 reads NULL and nothing is backfilled. No caller
// may treat NULL as 'user' or as "not harness" for a destructive decision — an absence
// is not evidence (roadmap non-negotiable #15). The sweep matches `= 'harness'`
// positively for that reason, so a NULL row is never inside its blast radius.
// ════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';

/** The three kinds the column's CHECK constraint allows (migration 134). */
export type CreatedByKind = 'user' | 'agent' | 'harness';

export const CREATED_BY_KINDS: readonly CreatedByKind[] = ['user', 'agent', 'harness'];

/**
 * Validate a caller-supplied kind. Returns null for anything not on the enum — the
 * caller then falls back to the kind it would have used anyway, so a typo'd or hostile
 * value can never widen what a sweep will delete, and the database's CHECK is the
 * backstop if this is ever bypassed.
 */
export function parseCreatedByKind(value: unknown): CreatedByKind | null {
  return typeof value === 'string' && (CREATED_BY_KINDS as readonly string[]).includes(value)
    ? (value as CreatedByKind)
    : null;
}

/**
 * The kind recorded on an agent, or null when the id names no agent (the tracker's
 * `created_by` also holds non-agent strings like 'dashboard') or the agent predates
 * migration 134. Never guesses.
 */
export function createdByKindOfAgent(agentId: string | null | undefined): CreatedByKind | null {
  if (!agentId) return null;
  try {
    const row = getDb()
      .prepare('SELECT created_by_kind FROM agents WHERE id = ?')
      .get(agentId) as { created_by_kind: string | null } | undefined;
    return parseCreatedByKind(row?.created_by_kind ?? null);
  } catch {
    // A read failure must never stop a creation: the row is still written, just
    // unstamped, which reads as "not recorded" and is swept by nobody.
    return null;
  }
}

/**
 * The kind for a row an AGENT is creating: inherit the creator's own kind when it is
 * recorded, otherwise 'agent'. A harness agent's tasks, projects and spawned children
 * are therefore 'harness' without the harness having to reach into any of them.
 */
export function inheritedCreatorKind(creatorAgentId: string | null | undefined): CreatedByKind {
  return createdByKindOfAgent(creatorAgentId) ?? 'agent';
}
