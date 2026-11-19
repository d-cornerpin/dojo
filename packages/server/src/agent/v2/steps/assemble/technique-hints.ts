// The assemble step's two first-iteration hints: the technique matcher and the context-gap nudge.
// One file because one shape: same fire condition, both append past the volatile boundary via the registry.

import { isPMAgent } from '../../../../config/platform.js';
import { listTechniques } from '../../../../techniques/store.js';
import { mayUseTechnique } from '../../../access/read.js';
import { SEMANTIC_STRONG_THRESHOLD, buildTechniqueMatchQuery, semanticTechniqueMatches } from '../../classifiers/technique.js';
import { injectRegistryMessage } from '../../../../prompt/registry/assembler.js';
import type { AssemblyContext } from '../../../../prompt/registry/types.js';
import type { AssembledContext } from '../../../../memory/assembler.js';
import type { AgentTurnState } from '../../state.js';
import { techniqueFitsRoom } from '../../../../memory/technique-room.js';
import { createLogger } from '../../../../logger.js';
import { techniqueFamilies, usableIntegrationFamilies } from '../../../../memory/integration-status-lane.js';

const logger = createLogger('v2-loop');
export interface TechniqueHintsInput {
  readonly agentId: string;
  readonly lastUserMessageContent: string | null;
  readonly mctx: AssemblyContext;
  readonly messages: AssembledContext['messages'];
  readonly roomTokens?: number;   // what the array has left for this injection (`memory/technique-room.ts`)
}

/** Appends nothing to `state`: neither block writes it; both mutate `mctx` and the messages in place. */
export async function injectTechniqueAndGapHints(state: AgentTurnState, input: TechniqueHintsInput): Promise<void> {
  const { agentId, lastUserMessageContent, mctx, messages, roomTokens } = input;

  // Engine-side fuzzy matching of the ask against published techniques, not a prompt instruction.
  // Fires only: first loop iteration, a real user message, never the PM (its reports land as role='user').
  if (state.loopCount === 1 && lastUserMessageContent && !isPMAgent(agentId)) {
    try {
      // The candidate set is the agent's GRANT, not the box's: a strong match inlines the whole TECHNIQUE.md,
      // so this filter is the door, the same `mayUseTechnique` every technique reader asks.
      const techniques = listTechniques({ state: 'published' })
        .filter((t) => mayUseTechnique(agentId, t.id))
        .map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description ?? undefined,
          tags: t.tags,
        }));
      // Semantic matching against technique-intent embeddings; token overlap remains only as its fallback.

      // Attachment-aware query: keep filename/kind as intent signal, strip pointer boilerplate.
      const matchQuery = buildTechniqueMatchQuery(lastUserMessageContent);
      const matches = await fitsTheAgentsIntegrations(agentId, await semanticTechniqueMatches(matchQuery, techniques));
      if (matches.length > 0) {
        // Strong match (score >= threshold): the technique body as its own message after the ask.
        // Weak match: a "may be relevant" note, the agent decides. At most one technique inlined per turn.
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
            const { getTechniqueDetail } = await import('../../../../techniques/store.js');
            const detail = getTechniqueDetail(strongMatch.technique.id);
            if (detail?.instructions && detail.instructions.length > 0) {
              const md = detail.instructions;
              const tooLarge = md.length > MAX_INLINE_CHARS || !techniqueFitsRoom(md.length, roomTokens);   // or more than the room left
              // A SEPARATE engine-marked message right AFTER the ask: prepending into the user's own
              // message would outrank their words; adjacency is what makes the model follow the technique.
              // A FACT, not an order: it says what the engine knows; naming a decision made it narrate.
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

        // Its own message AFTER the ask (post-assembly): role-merge cannot fuse it; stored rows untouched.
        if (techniqueInjection) {
          mctx.techniqueStrong = techniqueInjection;
          injectRegistryMessage('msg.technique-strong', messages, mctx);
        }

        // Weak matches (and a failed strong load) get the "may be relevant" note.
        const hintMatches = injectedTechniqueId === null
          ? matches
          : weakMatches;
        if (hintMatches.length > 0) {
          const lines = hintMatches.map((m) => {
            const desc = m.technique.description ? `: ${m.technique.description}` : '';
            return `- "${m.technique.name}"${desc}. use_technique('${m.technique.id}') loads it.`;
          });
          const weakHint = `[Engine note: ${injectedTechniqueId ? 'other saved techniques that' : 'saved techniques that'} may be relevant to this request.]\n` +
            lines.join('\n');
          // Post-tail engine message, NOT the system prompt: the match wording changes per message, so
          // keeping it out of the system prefix preserves prompt-cache warmth across turns.
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
      // "no such table" is tests/fresh-install noise: debug, not warn, keeps the WARN-rate signal clean.
      const msg = err instanceof Error ? err.message : String(err);
      const isMissingTable = /no such table/i.test(msg);
      if (isMissingTable) {
        logger.debug('v2 techniqueMatcher: techniques table not present (expected in tests/fresh DBs)', { agentId }, agentId);
      } else {
        logger.warn('v2 techniqueMatcher failed (non-fatal)', { agentId, error: msg }, agentId);
      }
    }
  }

  // Engine sees a gap (an attachment with no instruction): advisory nudge to ASK; the agent may ignore it.
  if (state.loopCount === 1 && lastUserMessageContent && !isPMAgent(agentId)) {
    try {
      // The guard is the loop's: it reads the live messages tail; the registry renders the gap message.
      if (messages.length === 0 || messages[messages.length - 1].role === 'user') {
        injectRegistryMessage('msg.context-gap', messages, mctx);
      }
    } catch { /* advisory only, never block the turn */ }
  }
}

/** An M365 technique NEVER rides a Gmail ask: one naming an integration's tools (from the tool-name table,
 *  never prose) is offered only when the agent can use that integration now. Never throws: offer blind. */
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
