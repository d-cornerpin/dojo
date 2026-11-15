// ════════════════════════════════════════════════════════════════════════════
// HEALER (self-repair) tools: `healer_log_action`, `healer_propose`, `healer_recent_actions`,
// `healer_action_detail`, `healer_mark_applied`. Three invariants that must not drift:
// - empty, not-found and already-applied answers keep `isError: false`: they are answers, not
//   failures, and grading them would be a new refusal.
// - `healer_propose`'s evidence gate keeps its full worked-example message: it teaches, and the
//   boundary's generic message would flatten that.
// - every `friendlyDbError(err, '<tool>')` keeps its own tool name, so the operator-facing DB
//   error still names the call that failed.
// ════════════════════════════════════════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../../db/connection.js';
import { broadcast } from '../../../gateway/ws.js';
import { friendlyDbError } from '../../tool-helpers.js';
import { getFreshDiagnosticSnapshot } from '../../../healer/diagnostic.js';
import { isHealerAgent, isPrimaryAgent } from '../../../config/platform.js';
import type { ToolHandlerMap } from '../handler.js';

export const healerHandlers: ToolHandlerMap = {
  async healer_log_action({ args }) {
    const healerDb = getDb();
    const actionId = uuidv4();
    try {
      healerDb.prepare(`
        INSERT INTO healer_actions (id, diagnostic_id, category, description, agent_id, action_taken, result, created_at)
        VALUES (?, NULL, ?, ?, ?, ?, ?, datetime('now'))
      `).run(actionId, args.category as string, args.description as string, (args.agent_id as string) ?? null, args.category as string, args.result as string);
      return { content: `[OK] action_id=${actionId}\n\nAction logged: ${args.description}`, isError: false };
    } catch (err) {
      return { content: friendlyDbError(err, 'healer_log_action'), isError: true };
    }
  },

  async healer_propose({ args }) {
    // Evidence gate: every bullet a non-empty string and the list non-empty, so a fix backed by
    // nothing cannot be proposed.
    const rawEvidence = args.evidence;
    let evidenceList: string[] = [];
    if (Array.isArray(rawEvidence)) {
      evidenceList = rawEvidence
        .filter((b) => typeof b === 'string' && b.trim().length > 0)
        .map((b) => (b as string).trim());
    }
    if (evidenceList.length === 0) {
      return {
        content:
          `Error: \`evidence\` is required and must be a non-empty array of short strings, each describing a specific observation you made in this cycle. ` +
          `Examples of valid bullets: "read messages table for agent abc12345, last assistant message was 2026-06-04T04:00Z", ` +
          `"audit_log shows 3 RATE_LIMIT model_call errors in the last 24h for agent abc12345", ` +
          `"vault_search returned no prior healer notes about this agent". ` +
          `If you cannot produce concrete observations to back the proposal, do not propose, log with healer_log_action instead.`,
        isError: true,
      };
    }

    // Provenance: the stale-proposal sweep re-finds the diagnostic that produced a proposal, so it
    // needs a stable key (agent_id, diagnostic_code), filled from the model when it can; without
    // the key the proposal only ever closes via the age-cap backstop, never by issue-matching.
    const proposalAgentId = (args.agent_id as string) ?? null;
    let diagnosticCode = typeof args.diagnostic_code === 'string' && args.diagnostic_code.trim().length > 0
      ? (args.diagnostic_code as string).trim()
      : null;
    let diagnosticId: string | null = null;
    try {
      const snapshot = getFreshDiagnosticSnapshot();
      if (snapshot) {
        diagnosticId = snapshot.id;
        if (!diagnosticCode && proposalAgentId) {
          // Auto-fill the code only when this agent has exactly one code open; with several, leave
          // it blank so the sweep falls back to agent-scope matching.
          const codesForAgent = [...new Set(
            snapshot.items.filter((it) => it.agentId === proposalAgentId).map((it) => it.code),
          )];
          if (codesForAgent.length === 1) diagnosticCode = codesForAgent[0];
        }
      }
    } catch {
      // No snapshot this process: fall back to model-supplied keys; the sweep degrades safely.
    }

    const propDb = getDb();
    const propId = uuidv4();
    try {
      propDb.prepare(`
        INSERT INTO healer_proposals (id, diagnostic_id, diagnostic_code, category, severity, title, description, proposed_fix, confidence, status, agent_id, evidence_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, datetime('now'))
      `).run(
        propId,
        diagnosticId,
        diagnosticCode,
        args.category as string,
        args.severity as string,
        args.title as string,
        args.description as string,
        args.proposed_fix as string,
        args.confidence as number,
        proposalAgentId,
        JSON.stringify(evidenceList),
      );
      // Typed via HealerProposalEvent (shared ws.ts): title and severity are validated strings
      // above, so the casts here are faithful.
      broadcast({ type: 'healer:proposal', data: { id: propId, title: args.title as string, severity: args.severity as string } });
      return {
        content: `[OK] proposal_id=${propId}\n\nProposal created: "${args.title}". The user will see this in the dashboard vitals panel and can approve or deny it.`,
        isError: false,
      };
    } catch (err) {
      return { content: friendlyDbError(err, 'healer_propose'), isError: true };
    }
  },

  async healer_recent_actions({ agentId, args }) {
    // Returns only (timestamp, category, agent, result), no descriptions, capped: the Healer's
    // prompt must not grow unbounded.
    if (!isHealerAgent(agentId) && !isPrimaryAgent(agentId)) {
      return { content: 'This tool is only available to the Healer agent.', isError: true };
    }
    const limit = Math.min(50, Math.max(1, (args.limit as number | undefined) ?? 20));
    const sinceHours = Math.min(168, Math.max(1, (args.since_hours as number | undefined) ?? 24));
    try {
      const db = getDb();
      const rows = db.prepare(`
        SELECT id, created_at, category, agent_id, result
        FROM healer_actions
        WHERE created_at > datetime('now', '-${sinceHours} hours')
        ORDER BY created_at DESC
        LIMIT ?
      `).all(limit) as Array<{ id: string; created_at: string; category: string; agent_id: string | null; result: string | null }>;
      if (rows.length === 0) {
        return { content: `No Healer actions in the last ${sinceHours}h.`, isError: false };
      }
      // Resolve agent IDs to names in a single batch query.
      const agentIds = [...new Set(rows.map((r) => r.agent_id).filter(Boolean))] as string[];
      const nameMap = new Map<string, string>();
      if (agentIds.length > 0) {
        const placeholders = agentIds.map(() => '?').join(',');
        const nameRows = db.prepare(`SELECT id, name FROM agents WHERE id IN (${placeholders})`)
          .all(...agentIds) as Array<{ id: string; name: string }>;
        for (const n of nameRows) nameMap.set(n.id, n.name);
      }
      // Each line ~80 chars; total well under 1500 char cap.
      const lines = rows.map((r) => {
        const who = r.agent_id ? (nameMap.get(r.agent_id) ?? r.agent_id) : '(no agent)';
        return `${r.created_at}  ${r.id.slice(0, 8)}  ${r.category.padEnd(20).slice(0, 20)}  ${who.padEnd(12).slice(0, 12)}  ${r.result ?? '?'}`;
      });
      const header = `(${rows.length} actions in last ${sinceHours}h, newest first)`;
      let body = `${header}\n${lines.join('\n')}`;
      if (body.length > 1500) body = body.slice(0, 1500) + '\n[truncated]';
      return { content: body, isError: false };
    } catch (err) {
      return { content: friendlyDbError(err, 'healer_recent_actions'), isError: true };
    }
  },

  async healer_action_detail({ agentId, args }) {
    if (!isHealerAgent(agentId) && !isPrimaryAgent(agentId)) {
      return { content: 'This tool is only available to the Healer agent.', isError: true };
    }
    const actionId = (args.action_id as string | undefined)?.trim();
    if (!actionId) {
      return { content: 'Error: action_id is required. Get IDs from healer_recent_actions.', isError: true };
    }
    try {
      const db = getDb();
      // Allow short-prefix match so the Healer can quote the
      // displayed 8-char prefix from healer_recent_actions.
      const row = db.prepare(`
        SELECT id, created_at, category, description, agent_id, action_taken, result
        FROM healer_actions
        WHERE id = ? OR id LIKE ?
        LIMIT 1
      `).get(actionId, `${actionId}%`) as
        | { id: string; created_at: string; category: string; description: string; agent_id: string | null; action_taken: string; result: string | null }
        | undefined;
      if (!row) {
        return { content: `No Healer action found for ID "${actionId}". Use healer_recent_actions to list recent ones.`, isError: false };
      }
      // Cap description so a runaway entry can't choke the model.
      const desc = (row.description ?? '').slice(0, 1500);
      let agentName = row.agent_id ?? '(no agent)';
      if (row.agent_id) {
        const n = db.prepare('SELECT name FROM agents WHERE id = ?').get(row.agent_id) as { name: string } | undefined;
        if (n?.name) agentName = n.name;
      }
      return {
        content:
          `Action ${row.id.slice(0, 8)} @ ${row.created_at}\n` +
          `Category: ${row.category}\n` +
          `Agent: ${agentName}\n` +
          `Action taken: ${row.action_taken}\n` +
          `Result: ${row.result ?? '?'}\n` +
          `Description: ${desc}` +
          (row.description && row.description.length > 1500 ? '\n[description truncated at 1500 chars]' : ''),
        isError: false,
      };
    } catch (err) {
      return { content: friendlyDbError(err, 'healer_action_detail'), isError: true };
    }
  },

  async healer_mark_applied({ agentId, args }) {
    // Closes the loop so the Vitals dashboard shows pending, approved and applied as three states.
    if (!isHealerAgent(agentId) && !isPrimaryAgent(agentId)) {
      return { content: 'This tool is only available to the Healer agent.', isError: true };
    }
    const proposalId = (args.proposal_id as string | undefined)?.trim();
    if (!proposalId) {
      return { content: 'Error: proposal_id is required.', isError: true };
    }
    const notes = (args.notes as string | undefined)?.slice(0, 500) ?? null;
    try {
      const db = getDb();
      // Resolve short-prefix match for convenience (mirrors action_detail).
      const row = db.prepare(`
        SELECT id, status, applied_at FROM healer_proposals
        WHERE id = ? OR id LIKE ?
        LIMIT 1
      `).get(proposalId, `${proposalId}%`) as
        | { id: string; status: string; applied_at: string | null }
        | undefined;
      if (!row) {
        return { content: `No proposal found for ID "${proposalId}".`, isError: true };
      }
      if (row.status !== 'approved') {
        return {
          content: `Proposal ${row.id.slice(0, 8)} has status "${row.status}", not "approved". Only approved proposals can be marked applied.`,
          isError: true,
        };
      }
      if (row.applied_at) {
        return { content: `Proposal ${row.id.slice(0, 8)} was already marked applied at ${row.applied_at}. No change.`, isError: false };
      }
      db.prepare(`
        UPDATE healer_proposals
        SET applied_at = datetime('now'),
            result_summary = COALESCE(?, result_summary)
        WHERE id = ?
      `).run(notes, row.id);
      // Broadcast so the Vitals card moves from "approved" to "applied" in real time.
      try {
        broadcast({
          type: 'healer:proposal',
          data: { id: row.id, status: 'applied' },
        });
      } catch { /* best effort */ }
      return { content: `Proposal ${row.id.slice(0, 8)} marked applied.${notes ? ' Notes recorded.' : ''}`, isError: false };
    } catch (err) {
      return { content: friendlyDbError(err, 'healer_mark_applied'), isError: true };
    }
  },
};
