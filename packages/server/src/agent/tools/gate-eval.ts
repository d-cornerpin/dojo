// ════════════════════════════════════════════════════════════════════════════
// ANSWERING A GATE (PHASE-5 T2 Steps 3 and 4).
//
// `gates.ts` DECLARES what each of the ladder's fifteen rows required; this file
// ANSWERS one. The split is the 400-line cap doing its job and it landed on a
// real seam: the declaration is a pure function of `(name, args)` that a test
// can enumerate without a database, and the evaluation is where the brokers, the
// grant rows and the platform's identity predicates get involved.
//
// The `errorCode` and `auditAs` fields on the outcome exist because parity is
// per ROW, not per family: six branches returned `PERMISSION_DENIED` and six
// returned a bare `isError`, one audited itself as `spawn` rather than
// `spawn_agent`, and `web_fetch`'s unparseable-URL arm was never a permission
// refusal at all. PHASE-4 T1 cluster 3 made `errorCode` the thing the outcome
// classifier reads, so flattening any of that would silently re-classify half
// the platform's refusals — a behaviour change wearing a tidy-up's clothes.
// ════════════════════════════════════════════════════════════════════════════

import { isPrimaryAgent, isHealerAgent, isPMAgent } from '../../config/platform.js';
import { effectsFor } from './registry.js';
import {
  authorizeFs, authorizeAppleScript, authorizeNet, authorizeSpawn, authorizeSystemControl,
  authorizeExecShapedCall,
  resolvePathArg, resolveCommandArg, resolveUrlArg, resolveFixedHost,
  grantFor, type Verdict,
} from '../brokers/index.js';
import { EFFECT_FROM_ARGS, EFFECT_FROM_FIXED, type EffectKind } from './types.js';
import type { ToolGate } from './gates.js';

/** What a gate answered, plus enough to audit and render it. */
export interface GateOutcome {
  readonly gate: ToolGate;
  readonly verdict: Verdict;
  /** The resource the gate looked at, for the audit row. Null for identity gates. */
  readonly resource: string | null;
  /**
   * The `errorCode` the LADDER's own branch returned, preserved per row.
   *
   * It is not uniform and it must not become uniform here: six branches returned
   * `PERMISSION_DENIED` and six returned `isError: true` with no code at all,
   * and PHASE-4 T1 cluster 3 made that code the thing the outcome classifier
   * reads. Flattening it would silently re-classify half the platform's
   * refusals, which is a behaviour change wearing a tidy-up's clothes.
   */
  readonly errorCode: 'PERMISSION_DENIED' | null;
  /** The action name the ladder's own `auditLog` call used, where it differed
   *  from the tool name (branch 4 audited `spawn`, not `spawn_agent`). */
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

/** This gate does not apply to this call. */
function skip(gate: ToolGate): GateOutcome {
  return { gate, verdict: allowed, resource: null, errorCode: null, auditAs: '' };
}

function denied(rule: string, reason: string, blockedMessage: string | null = null): Verdict {
  return { allowed: false, basis: 'ladder-parity', rule, reason, blockedMessage };
}

/**
 * Where a declared effect's resource comes from. `args.<dotted>` walks the
 * argument object; `fixed:<host>` is a constant the tool always touches.
 * `derived:*` cannot be resolved before the handler runs and is therefore never
 * a gate — which is a fact about the tool, recorded rather than papered over.
 */
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

/** ONE gate, answered. */
export async function evaluateGate(gate: ToolGate, ctx: GateContext): Promise<GateOutcome> {
  const { agentId, name, args } = ctx;

  switch (gate.kind) {
    case 'fs': {
      const from = declaredFrom(name, gate.effect);
      if (!from || !from.startsWith(EFFECT_FROM_ARGS)) return skip(gate);
      const raw = readArgPath(args, from.slice(EFFECT_FROM_ARGS.length));
      const resolved = resolvePathArg(raw);
      if (!resolved.ok) {
        // ABSENT → the gate does not apply, which is exactly what `if (filePath)`
        // did; the handler produces its own friendlier error. PRESENT-but-not-a-
        // string → refused, replacing a `path.resolve` crash.
        if (resolved.code === 'not_present') return skip(gate);
        return { gate, verdict: denied('arg-not-a-string', resolved.reason), resource: null, errorCode: 'PERMISSION_DENIED', auditAs: name };
      }
      return {
        gate,
        verdict: authorizeFs(grantFor(agentId), gate.effect, resolved.value),
        resource: resolved.value.lexical,
        errorCode: 'PERMISSION_DENIED',
        auditAs: name,
      };
    }

    // ── Row 3 / 3s: the two exec doors, through the ONE seam (RULING P5-R3) ──
    // `authorizeExecShapedCall` is literally the function `destructive-gate.ts`
    // calls for its pre-hold check, which is what makes its comment — *"the
    // EXACT call executeTool makes"* — a fact rather than a hope. An absent
    // argument still SKIPS (the `if (filePath)` parity T2 preserved); a present
    // but malformed one is REFUSED and never coerced to empty.
    case 'proc':
    case 'shell': {
      const from = declaredFrom(name, gate.kind);
      if (!from || !from.startsWith(EFFECT_FROM_ARGS)) return skip(gate);
      const raw = readArgPath(args, from.slice(EFFECT_FROM_ARGS.length));
      if (raw === undefined || raw === null) return skip(gate);
      const verdict = authorizeExecShapedCall(grantFor(agentId), gate.kind, raw);
      return {
        gate,
        verdict,
        resource: Array.isArray(raw) ? raw.join(' ') : String(raw),
        errorCode: 'PERMISSION_DENIED',
        auditAs: name,
      };
    }

    // ── Row 15's applescript half: the SCRIPT is what gets authorized ──
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
      // 14b applies to SUB-AGENTS only — the primary browses freely, and that is
      // the branch's own comment, not an inference.
      if (gate.subAgentsOnly && isPrimaryAgent(agentId)) return skip(gate);
      const from = declaredFrom(name, 'net');
      if (!from) return skip(gate);
      if (from.startsWith(EFFECT_FROM_FIXED)) {
        // Branch 6: `web_search` has NO url argument and reaches one fixed host.
        // §T0-PINS P1 names it as one of the two gates easiest to lose.
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
        // The ladder answered an unparseable url with `Invalid URL: <url>` and a
        // bare `isError` — NOT a permission refusal, and NOT an audit row. Kept
        // byte-for-byte, `errorCode` absence included.
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
            // Rows 7 and 13 carried PERMISSION_DENIED; row 9 (PRIMARY_ONLY_TOOLS)
            // did not. Not a tidy distinction, and not this task's to tidy.
            errorCode: gate.row === '9' ? null : 'PERMISSION_DENIED',
            auditAs: name,
          };

    case 'primary_or_healer':
      return isPrimaryAgent(agentId) || isHealerAgent(agentId)
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

    case 'pm_only_operation':
      return isPMAgent(agentId)
        ? skip(gate)
        : {
            gate,
            verdict: denied(
              `pm-only:${gate.operation}`,
              `${gate.operation} is restricted to the PM agent`,
              `Permission denied: only the PM agent can call ${gate.operation}. If you think the engine or PM got it wrong, call work_close_request(action="override") with a justification instead.`,
            ),
            resource: null,
            errorCode: 'PERMISSION_DENIED',
            auditAs: name,
          };

    case 'creator_only': {
      const target = ctx.resolveRef(gate.entity, gate.ref);
      // An unresolved ref falls through to the handler's own not-found error —
      // the ladder's behaviour, and the friendlier message.
      if (!target || target.createdBy === agentId) return skip(gate);
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
// ⚰ ENFORCEMENT STAGING — DELETED (PHASE-5 T7). The predicate this file
// carried is gone by NAME, so its identifier greps to zero across production
// source and the exit gate is a command anyone can re-run.
//
// T2 Step 4 shipped a staged-enablement branch: for a sub-agent, a refusal whose
// basis was `bypass-hardening` and whose rule was not a global deny could be
// RECORDED instead of APPLIED. RULING P5-R6 narrowed it twice after the live box
// showed what the literal wording cost, and what was left was a window that was
// EMPTY — held empty, not merely believed empty, by
// `brokers/__tests__/staged-set.test.ts`'s census over the broker sources.
//
// T7 deletes the branch by name because that is this phase's own exit gate: a
// staging flag that survives its stage is the band-aid this phase exists to
// kill, and the check is honest in both directions only because the identifier
// was grep-zero before T2 created it (§T0-PINS P9).
//
// **requirement preserved:** every refusal the brokers compute is APPLIED, to
// every agent, and none is recorded-but-not-applied. It is now STRUCTURAL rather
// than predicated — the executor has one refusal path and it does not ask who
// the agent is (`tools/__tests__/ladder-rows.test.ts`, three clauses). The other
// half — that no refusal the brokers actually produce would have been staged on
// the day this died, i.e. that the deletion changed no behaviour — stays with
// the census in `staged-set.test.ts`.
// ════════════════════════════════════════════════════════════════════════════
