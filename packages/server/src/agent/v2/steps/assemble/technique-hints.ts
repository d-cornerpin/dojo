// ════════════════════════════════════════
// PHASE-6 T4 (CUT 6) — the `assemble` step's TWO FIRST-ITERATION HINTS, moved
// byte-faithfully out of `loop.ts`: the technique matcher and the context-gap
// nudge. They are one file because they are one shape — both fire on the first
// iteration of a turn that carries a real user message, both append to the TAIL
// past the volatile boundary, and both go through the registry rather than
// touching the array themselves.
//
// The split is on a seam the block already had: the two sit adjacent in the span
// and share their fire condition to the character.
// ════════════════════════════════════════

import { isPMAgent } from '../../../../config/platform.js';
import { listTechniques } from '../../../../techniques/store.js';
import { mayUseTechnique } from '../../../access/read.js';
import { SEMANTIC_STRONG_THRESHOLD, buildTechniqueMatchQuery, semanticTechniqueMatches } from '../../classifiers/technique.js';
import { injectRegistryMessage } from '../../../../prompt/registry/assembler.js';
import type { AssemblyContext } from '../../../../prompt/registry/types.js';
import type { AssembledContext } from '../../../../memory/assembler.js';
import type { AgentTurnState } from '../../state.js';
import type { TurnContext } from '../../../turn-context.js';
import { techniqueFitsRoom } from '../../../../memory/technique-room.js';
import { createLogger } from '../../../../logger.js';
import { techniqueFamilies, usableIntegrationFamilies } from '../../../../memory/integration-status-lane.js';

const logger = createLogger('v2-loop');
export interface TechniqueHintsInput {
  readonly agentId: string;
  readonly turnCtx: TurnContext;
  readonly lastUserMessageContent: string | null;
  readonly mctx: AssemblyContext;
  readonly messages: AssembledContext['messages'];
  readonly roomTokens?: number;   // what the array has left for this injection (`memory/technique-room.ts`)
}

/** Appends nothing to `state`: neither block writes it. Both mutate `mctx` and the
 *  message array in place, exactly as they did inside the loop body. */
export async function injectTechniqueAndGapHints(state: AgentTurnState, input: TechniqueHintsInput): Promise<void> {
  const { agentId, turnCtx, lastUserMessageContent, mctx, messages, roomTokens } = input;

  // ── Technique matcher (Part VI #5, Phase 5) ──
  // Replaces v1's "MANDATORY: Check Techniques Before Starting Work"
  // prompt instruction with engine-side fuzzy matching: when the user
  // sends a message, the engine matches their intent against published
  // techniques and surfaces relevant ones in the system prompt. The
  // agent doesn't have to remember to check the index.
  //
  // Only fires:
  //   - on the first loop iteration of a turn (not per tool call)
  //   - when there is a last user message (not on auto-continuations,
  //     A2A wakes, or PM pokes, those carry their own context)
  //   - not for the PM agent (situation reports land as role='user',
  //     don't need technique hints injected on every poke tick).
  if (state.loopCount === 1 && lastUserMessageContent && !isPMAgent(agentId)) {
    try {
      // UX-ACCESS A4 — THE CANDIDATE SET IS THE AGENT'S GRANT, NOT THE BOX'S.
      //
      // This is the loudest of the four technique seams and the reason the grant
      // could not be advertisement-only: a STRONG match inlines the whole
      // TECHNIQUE.md as its own message and calls `recordTechniqueUsage` below —
      // the agent runs a standing procedure it never asked for and never saw a
      // door for. Filtering here is the door, and it is the same predicate the
      // index and `checkTechniqueAccess` ask.
      const techniques = listTechniques({ state: 'published' })
        .filter((t) => mayUseTechnique(agentId, t.id))
        .map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description ?? undefined,
          tags: t.tags,
        }));
      // Match the ask against technique-intent embeddings (remediation
      // Phase 2). Semantic matching went GREEN on the floor model in
      // S5.4/S5.5 (0.56/0.68/0.72 strong matches on zero-overlap
      // phrasings; clean on unrelated pings). The token-overlap matcher
      // survives only as semanticTechniqueMatches' internal fallback for
      // when the embedding service is down (recall weakens, never zeroes).

      // Attachment-aware query (remediation Phase 3, S5.1/S5.2): keep the
      // attachment filename/kind as intent signal, strip pointer
      // boilerplate so a photo-with-little-text message can still match a
      // photo technique.
      const matchQuery = buildTechniqueMatchQuery(lastUserMessageContent);
      const matches = await fitsTheAgentsIntegrations(agentId, await semanticTechniqueMatches(matchQuery, techniques));
      if (matches.length > 0) {
        // Two modes:
        //   - STRONG MATCH (score >= 0.5): the engine loads TECHNIQUE.md
        //     and WRAPS the user's most recent message with the technique
        //     body, framed as authoritative guidance from the user. The
        //     wrap is in-message (user-role, adjacent to the ask) rather
        //     than appended to the system prompt, frontier models weight
        //     user-role instructions and recent tokens far more than
        //     buried system-prompt rules. v2.2.8 inlined into the system
        //     prompt and the model still ignored it; v2.3.2 puts the
        //     technique where the model actually pays attention.
        //   - WEAK MATCH (score < 0.5): keep the existing hint behavior
        //     in the system prompt; agent decides whether to load.
        //
        // Cap at one auto-injected technique per turn to keep token cost
        // bounded. If the technique is too large to inline (>25K chars ≈
        // 6K tokens), still wrap the user message but with a load-it
        // instruction instead of the full body.
        const STRONG_MATCH_THRESHOLD = SEMANTIC_STRONG_THRESHOLD;
        const MAX_INLINE_CHARS = 25_000;
        const strongMatch = matches[0].score >= STRONG_MATCH_THRESHOLD ? matches[0] : null;
        const weakMatches = strongMatch
          ? matches.slice(1).filter((m) => m.score < STRONG_MATCH_THRESHOLD)
          : matches;

        let injectedTechniqueId: string | null = null;
        let techniqueInjection: string | null = null;
        if (strongMatch) {
          try {
            const { getTechniqueDetail, recordTechniqueUsage } = await import('../../../../techniques/store.js');
            const detail = getTechniqueDetail(strongMatch.technique.id);
            if (detail?.instructions && detail.instructions.length > 0) {
              const md = detail.instructions;
              const tooLarge = md.length > MAX_INLINE_CHARS || !techniqueFitsRoom(md.length, roomTokens);   // t29: or more than the room left
              // Audit C12: the old implementation PREPENDED this text into
              // the user's own message, so an engine directive borrowed
              // tier-1 authority and structurally outranked the user's
              // actual words. The preserved reason (v2.2.8 → v2.3.2
              // history): adjacency to the ask is what makes the model
              // follow the technique; system-prompt placement was ignored.
              // So: keep adjacency by injecting a SEPARATE engine-marked
              // message right after the ask, framed at its true tier
              // (task/technique notes, below the live user message).
              // v3.5 owner test 2, fix rank 5: a FACT, not an order. The old header named the mechanism ("engine-injected"),
              // asserted a match ("This task matches") and handed the model a decision ("Follow ... unless"); the model
              // narrated its decision to the owner. The note says what the engine knows, and nothing else.
              const header = `[Engine note: a saved technique, "${strongMatch.technique.name}", may be relevant to this request.`;
              if (tooLarge) {
                techniqueInjection =
                  `${header} Its steps are too long to show here (${md.length} chars); use_technique('${strongMatch.technique.id}') loads them.]`;
              } else {
                techniqueInjection =
                  `${header} Its steps follow.]\n\n` +
                  `--- TECHNIQUE: ${strongMatch.technique.name} ---\n${md}\n--- END TECHNIQUE ---`;
              }
              injectedTechniqueId = strongMatch.technique.id;
              turnCtx.turnInjectedTechniqueId = strongMatch.technique.id;
              try { recordTechniqueUsage(strongMatch.technique.id, agentId); } catch { /* best effort */ }
              logger.info('v2 techniqueMatcher: injecting strong-match technique as engine message', {
                agentId,
                techniqueId: strongMatch.technique.id,
                techniqueName: strongMatch.technique.name,
                score: strongMatch.score,
                contentChars: md.length,
                inlinedFully: !tooLarge,
              }, agentId);
            }
          } catch (loadErr) {
            logger.warn('v2 techniqueMatcher: strong-match load failed, falling back to hint', {
              agentId,
              techniqueId: strongMatch.technique.id,
              error: loadErr instanceof Error ? loadErr.message : String(loadErr),
            }, agentId);
          }
        }

        // Inject as its own message AFTER the ask (post-assembly, so the
        // role-merge mutation cannot fuse it into the user's message or a
        // tool_result). The DB-stored rows are untouched, only this
        // in-flight model call sees the injection.
        if (techniqueInjection) {
          mctx.techniqueStrong = techniqueInjection;
          injectRegistryMessage('msg.technique-strong', messages, mctx);
        }

        // Weak matches (and the strong match if its load failed) get the
        // legacy "consider these" hint.
        const hintMatches = injectedTechniqueId === null
          ? matches
          : weakMatches;
        if (hintMatches.length > 0) {
          // v3.5 owner test 2, fix rank 5: facts, not orders (no "matched", no "load any", no match strength).
          const lines = hintMatches.map((m) => {
            const desc = m.technique.description ? `: ${m.technique.description}` : '';
            return `- "${m.technique.name}"${desc}. use_technique('${m.technique.id}') loads it.`;
          });
          const weakHint = `[Engine note: ${injectedTechniqueId ? 'other saved techniques that' : 'saved techniques that'} may be relevant to this request.]\n` +
            lines.join('\n');
          // Inject as a post-tail engine message (NOT appended to the
          // system prompt). The match-strength wording changes per user
          // message, so keeping it out of the system prefix preserves
          // prompt-cache warmth across turns. Mirrors the strong-match
          // injection above (its own message, after the ask).
          mctx.techniqueWeakHint = weakHint;
          injectRegistryMessage('msg.technique-weak', messages, mctx);
        }
        logger.debug('v2 techniqueMatcher: surfaced matches', {
          agentId,
          matchCount: matches.length,
          autoInjected: injectedTechniqueId,
          names: matches.map((m) => m.technique.name),
        }, agentId);
      }
    } catch (err) {
      // "no such table: techniques" fires during integration test runs
      // (mocked in-memory DB without the techniques table) and pre-migration
      // fresh installs. It's not a production failure mode, log at debug,
      // not warn, so it doesn't pollute the WARN-rate acceptance signal.
      const msg = err instanceof Error ? err.message : String(err);
      const isMissingTable = /no such table/i.test(msg);
      if (isMissingTable) {
        logger.debug('v2 techniqueMatcher: techniques table not present (expected in tests/fresh DBs)', { agentId }, agentId);
      } else {
        logger.warn('v2 techniqueMatcher failed (non-fatal)', { agentId, error: msg }, agentId);
      }
    }
  }

  // ── Context-gap detection (2026-06-15, "ask when stuck") ──
  // The engine nudges the agent to ASK the user when it can SEE the agent
  // lacks enough to proceed (v1: an attachment with no instruction),
  // instead of inferring intent or hoping a weak model notices. Advisory
  // [Engine hint] via the one engine-message channel; the agent uses
  // judgment (and ignores it when a task/technique/context covers the gap).
  // Same fire conditions as the technique matcher: first iteration, real
  // user message, not the PM.
  if (state.loopCount === 1 && lastUserMessageContent && !isPMAgent(agentId)) {
    try {
      // Same site, same alternation guard, byte-identical injection. Registry
      // mode renders msg.context-gap (same detectContextGap call) and injects
      // through the registry channel; legacy mode inline. The guard is the
      // loop's (it depends on the live messages tail).
      if (messages.length === 0 || messages[messages.length - 1].role === 'user') {
        injectRegistryMessage('msg.context-gap', messages, mctx);
      }
    } catch { /* advisory only, never block the turn */ }
  }
}

/**
 * v3.5 owner test 2, fix rank 5: AN M365 TECHNIQUE NEVER RIDES A GMAIL ASK. The gate is structural: a technique whose
 * procedure names an integration's tools (`techniqueFamilies`, from the tool-name table, never prose) is offered only when
 * the agent can use that integration now (configured, granted, connected). A technique that names no integration is not
 * gated. Never throws: an unreadable technique is offered as before.
 */
async function fitsTheAgentsIntegrations<M extends { technique: { id: string; tags?: string[] } }>(agentId: string, matches: M[]): Promise<M[]> {
  if (matches.length === 0) return matches;
  const usable = await usableIntegrationFamilies(agentId);
  const { getTechniqueDetail } = await import('../../../../techniques/store.js');
  return matches.filter((m) => {
    try {
      const families = techniqueFamilies(getTechniqueDetail(m.technique.id)?.instructions ?? null, m.technique.tags ?? []);
      if (families.size === 0 || [...families].some((f) => usable.has(f))) return true;
      logger.info('v2 technique: not offered, it works in an integration this agent cannot use now', {
        agentId, techniqueId: m.technique.id, families: [...families], usable: [...usable],
      }, agentId);
      return false;
    } catch {
      return true;
    }
  });
}
