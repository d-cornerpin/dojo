// ════════════════════════════════════════════════════════════════════════════
// ANSWERING A GATE: `gates.ts` DECLARES each ladder row's requirement; this
// file ANSWERS one. Declaration is pure
// and testable without a database; evaluation touches brokers, grant rows and
// identity predicates. `errorCode` and `auditAs` are per ROW, not per family:
// the outcome classifier reads `errorCode`, so flattening the mix of codes and
// bare refusals would silently re-classify refusals. Keep both fields exact.
// ════════════════════════════════════════════════════════════════════════════

import { isPrimaryAgent, holdsResetSession, isPMAgent, getPMAgentId } from '../../config/platform.js';
import { effectsFor } from './registry.js';
import {
  authorizeFs, authorizeAppleScript, authorizeNet, authorizeSpawn, authorizeSystemControl,
  authorizeExecShapedCall,
  resolveCommandArg, resolveUrlArg, resolveFixedHost,
  grantFor, type Verdict,
} from '../brokers/index.js';
import { EFFECT_FROM_ARGS, EFFECT_FROM_FIXED, type EffectKind } from './types.js';
import {
  mayUseChannel, holdsCredentialGrant,
  toolCategoryGranted, toolCategoryLabels,
} from '../access/read.js';
import { heldGroupsClause } from './held-groups.js';
import { holdsDojoInspect, DOJO_INSPECT_REFUSAL } from '../../inspect/grant.js';
import type { ToolGate } from './gates.js';
import { callerPaths } from '../effects/scopes.js';
import { resolveProcessCwd } from './process-run.js';

/** What a gate answered, plus enough to audit and render it. */
export interface GateOutcome {
  readonly gate: ToolGate;
  readonly verdict: Verdict;
  /** The resource the gate looked at, for the audit row. Null for identity gates. */
  readonly resource: string | null;
  /** Ladder-row-specific `errorCode`; the outcome classifier reads it, so the
   *  mix of codes and bare refusals must not be flattened or rows re-classify. */
  readonly errorCode: 'PERMISSION_DENIED' | null;
  /** The action name the ladder's `auditLog` used where it differs (one row audits `spawn`). */
  readonly auditAs: string;
}

export interface GateContext {
  readonly agentId: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  /** `kill_agent` / `delete_group` ref resolution, injected so this module does
   *  not have to import `agent/tools.ts` and close a cycle. */
  readonly resolveRef: (entity: 'agent' | 'group', ref: string) => { id: string; createdBy: string | null; label: string } | null;
}

const allowed: Verdict = { allowed: true, rule: 'gate-not-applicable' };

function skip(gate: ToolGate): GateOutcome {
  return { gate, verdict: allowed, resource: null, errorCode: null, auditAs: '' };
}

function denied(rule: string, reason: string, blockedMessage: string | null = null): Verdict {
  return { allowed: false, basis: 'ladder-parity', rule, reason, blockedMessage };
}

/** Resource source for a declared effect: `args.<dotted>` walks the argument
 *  object, `fixed:<host>` is a constant; `derived:*` cannot resolve before the
 *  handler runs, so it is never a gate. */
function declaredFrom(name: string, kind: EffectKind): string | null {
  const effect = effectsFor(name)?.find((e) => e.kind === kind);
  return effect?.from ?? null;
}

function readArgPath(args: Record<string, unknown>, dotted: string): unknown {
  let cursor: unknown = args;
  for (const segment of dotted.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

export async function evaluateGate(gate: ToolGate, ctx: GateContext): Promise<GateOutcome> {
  const { agentId, name, args } = ctx;

  switch (gate.kind) {
    // Every path the caller names is asked; a read that leaves the Mac is asked on the share surface.
    case 'fs': {
      for (const [resolved, effect] of gate.effects.flatMap((e) => callerPaths(e, args).map((r) => [r, e] as const))) {
        // Present but not a string: refused, never coerced.
        if (!resolved.ok) return { gate, verdict: denied('arg-not-a-string', resolved.reason), resource: null, errorCode: 'PERMISSION_DENIED', auditAs: name };
        const verdict = authorizeFs(grantFor(agentId), gate.effect, resolved.value, effect.leaves ? 'share' : 'tool', name);
        if (!verdict.allowed) return { gate, verdict, resource: resolved.value.lexical, errorCode: 'PERMISSION_DENIED', auditAs: name };
      }
      return skip(gate);
    }

    // Both exec doors share ONE seam: `authorizeExecShapedCall`, the same call
    // `destructive-gate.ts` uses. Absent arg skips; malformed arg is refused.
    case 'proc':
    case 'shell': {
      const from = declaredFrom(name, gate.kind);
      if (!from || !from.startsWith(EFFECT_FROM_ARGS)) return skip(gate);
      const raw = readArgPath(args, from.slice(EFFECT_FROM_ARGS.length));
      if (raw === undefined || raw === null) return skip(gate);
      const verdict = authorizeExecShapedCall(grantFor(agentId), gate.kind, raw, resolveProcessCwd(args.cwd).cwd);
      return {
        gate,
        verdict,
        resource: Array.isArray(raw) ? raw.join(' ') : String(raw),
        errorCode: 'PERMISSION_DENIED',
        auditAs: name,
      };
    }

    // The applescript row: the SCRIPT itself is what gets authorized.
    case 'applescript': {
      const from = declaredFrom(name, 'applescript');
      if (!from || !from.startsWith(EFFECT_FROM_ARGS)) return skip(gate);
      const raw = readArgPath(args, from.slice(EFFECT_FROM_ARGS.length));
      const resolved = resolveCommandArg(raw);
      if (!resolved.ok) {
        if (resolved.code === 'not_present') return skip(gate);
        return { gate, verdict: denied('arg-not-a-string', resolved.reason), resource: null, errorCode: 'PERMISSION_DENIED', auditAs: name };
      }
      return {
        gate,
        verdict: authorizeAppleScript(grantFor(agentId), resolved.value),
        resource: resolved.value.trimmed.slice(0, 200),
        errorCode: 'PERMISSION_DENIED',
        auditAs: name,
      };
    }

    case 'net': {
      // A sub-agent-only net gate: the primary agent browses freely.
      if (gate.subAgentsOnly && isPrimaryAgent(agentId)) return skip(gate);
      const from = declaredFrom(name, 'net');
      if (!from) return skip(gate);
      if (from.startsWith(EFFECT_FROM_FIXED)) {
        // `web_search` has NO url argument and reaches one fixed host: easy to lose.
        const host = from.slice(EFFECT_FROM_FIXED.length);
        return {
          gate,
          verdict: await authorizeNet(grantFor(agentId), resolveFixedHost(host)),
          resource: host,
          errorCode: 'PERMISSION_DENIED',
          auditAs: name,
        };
      }
      if (!from.startsWith(EFFECT_FROM_ARGS)) return skip(gate);
      const raw = readArgPath(args, from.slice(EFFECT_FROM_ARGS.length));
      const resolved = resolveUrlArg(raw);
      if (!resolved.ok) {
        if (resolved.code === 'not_present') return skip(gate);
        // An unparseable url is not a permission refusal: bare `isError`, no audit row.
        return {
          gate,
          verdict: denied('invalid-url', resolved.reason, `Invalid URL: ${String(raw)}`),
          resource: null,
          errorCode: null,
          auditAs: name,
        };
      }
      return {
        gate,
        verdict: await authorizeNet(grantFor(agentId), resolved.value),
        resource: resolved.value.href,
        errorCode: 'PERMISSION_DENIED',
        auditAs: name,
      };
    }

    case 'spawn':
      // The ladder audited this one as `spawn`, not `spawn_agent`.
      return { gate, verdict: authorizeSpawn(grantFor(agentId)), resource: null, errorCode: 'PERMISSION_DENIED', auditAs: 'spawn' };

    case 'primary_only':
      return isPrimaryAgent(agentId)
        ? skip(gate)
        : {
            gate,
            verdict: denied(`primary-only:${name}`, `${name} is restricted to the primary agent only`, gate.message),
            resource: null,
            // Keep per-row: row 9 refuses with no code, rows 7 and 13 with PERMISSION_DENIED.
            errorCode: gate.row === '9' ? null : 'PERMISSION_DENIED',
            auditAs: name,
          };

    // The channel row asks `mayUseChannel`, not `isPrimaryAgent`: the refused
    // set is the same (the primary holds it) but the owner can now change it.
    case 'channel':
      return mayUseChannel(agentId, gate.channel)
        ? skip(gate)
        : {
            gate,
            verdict: denied(`channel:${gate.channel}`, `${name} is restricted to the primary agent only`, gate.message),
            resource: gate.channel,
            errorCode: 'PERMISSION_DENIED',
            auditAs: name,
          };

    // The credential row asks ONE question, a single grant switch. `gate.service`
    // survives as the AUDIT resource: the message lost detail on purpose, the
    // ledger row did not.
    case 'credential':
      return holdsCredentialGrant(agentId) ? skip(gate) : {
        gate,
        verdict: denied(
          'credential-not-granted',
          'this agent has no access to stored credentials',
          'Permission denied: this agent does not have access to stored credentials. The request was not performed. Ask the primary agent to grant it if this needs to happen.',
        ),
        resource: gate.service,
        errorCode: 'PERMISSION_DENIED',
        auditAs: name,
      };

    // The category row is the wall behind `surface.ts`'s advertised-list strip:
    // same predicate, asked not re-implemented. Any group passes, no group never
    // refuses; `toolCategoryGranted` owns both rules.
    case 'category': {
      if (toolCategoryGranted(agentId, name)) return skip(gate);
      const labels = toolCategoryLabels(name);
      const named = labels.length === 1 ? `"${labels[0]}"` : labels.map((l) => `"${l}"`).join(' or ');
      return {
        gate,
        verdict: denied(
          `category-not-granted:${labels[0]}`,
          `${name} is in the ${named} tool group, which is not in this agent's grants`,
          `Permission denied: ${name} is in the ${named} tool group, which is not in this agent's grants.`
            + ' The request was not performed. Ask the primary agent to grant that group if this needs to happen.'
            + heldGroupsClause(agentId),   // what this agent DOES hold, so the next call picks a held group
        ),
        resource: labels[0],
        errorCode: 'PERMISSION_DENIED',
        auditAs: name,
      };
    }

    case 'primary_or_healer':
      return holdsResetSession(agentId)
        ? skip(gate)
        : {
            gate,
            verdict: denied(
              'primary-or-healer:reset_session',
              'reset_session is restricted to the primary agent and the Healer',
              'Permission denied: reset_session is reserved for the primary agent and the platform Healer. The request was not performed.',
            ),
            resource: null,
            errorCode: null,
            auditAs: name,
          };

    case 'inspect_grant':
      return holdsDojoInspect(agentId) ? skip(gate) : {
        gate, verdict: denied('inspect-grant:dojo_inspect', 'dojo_inspect is held by the main agent, the Healer and agents whose grant names it', DOJO_INSPECT_REFUSAL),
        resource: null, errorCode: 'PERMISSION_DENIED', auditAs: name,
      };

    case 'pm_only_operation':
      return isPMAgent(agentId) || isPrimaryAgent(agentId)
        ? skip(gate)
        : {
            gate,
            verdict: denied(
              `pm-only:${gate.operation}`,
              `${gate.operation} is restricted to the PM agent and the main agent`,
              `Permission denied: only the PM agent and the main agent can call ${gate.operation}. If you think the engine or PM got it wrong, tell the PM why with send_to_agent(agent="${getPMAgentId()}", ...) instead.`,
            ),
            resource: null,
            errorCode: 'PERMISSION_DENIED',
            auditAs: name,
          };

    case 'creator_only': {
      const target = ctx.resolveRef(gate.entity, gate.ref);
      // An unresolved ref falls through to the handler's own friendlier not-found error; the main agent may end any.
      if (!target || target.createdBy === agentId || isPrimaryAgent(agentId)) return skip(gate);
      const byUser = target.createdBy === 'dashboard' || target.createdBy === 'user' || target.createdBy === 'system';
      const noun = gate.entity === 'agent' ? 'sub-agents you created' : 'squads you created';
      const verb = gate.entity === 'agent' ? 'kill' : 'delete';
      return {
        gate,
        verdict: denied(
          `creator-only:${gate.entity}`,
          `not the creator (created_by=${target.createdBy})`,
          `You can only ${gate.entity === 'agent' ? 'dismiss' : 'delete'} ${noun}. "${target.label}" was created by ${byUser ? 'the user' : 'a different agent'}, so it is not yours to ${verb}. ${byUser ? 'The user dismisses it from the dashboard.' : 'Ask its creator, or the user can dismiss it from the dashboard.'}`,
        ),
        resource: target.id,
        errorCode: null,
        auditAs: name,
      };
    }

    case 'system_control':
      return {
        gate,
        verdict: authorizeSystemControl(grantFor(agentId), gate.category, name),
        resource: gate.category,
        errorCode: 'PERMISSION_DENIED',
        auditAs: name,
      };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Every refusal the brokers compute is APPLIED, to every agent; nothing is
// recorded-but-not-applied. That is structural: the executor has one refusal
// path and it asks no identity; `tools/__tests__/ladder-rows` pins that shape.
// ════════════════════════════════════════════════════════════════════════════
