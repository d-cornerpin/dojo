// ════════════════════════════════════════════════════════════════════════════
// TECHNIQUES (PHASE-5 T4 — relocated from `agent/tools.ts`)
//
// The twelve tools `tools/categories.ts` files under "Techniques".
//
// RELOCATION, NOT REWRITE. Every body is the body that stood in the switch,
// byte-faithful, including the per-case `agentRow2` / `agentRow3` / `taRow` /
// `sfrRow` local names that only existed because twelve cases shared one
// function scope. They are kept: renaming them would be tidying done during a
// move, and a diff that renames is a diff a reviewer cannot check by eye.
//
// `delete_technique`'s trainer/sensei fallback ladder — the one that keeps
// delete working on an install with the trainer disabled or dead — is carried
// across with its exact refusal wording and its `trainerLive` IIFE.
//
// ── THE `techniques/tools.js` LAZY LOADS ARE KEPT, DELIBERATELY ──
// §T0-PINS P8 pins them SANCTIONED and says they MOVE WITH THEIR HANDLERS: nine
// `await import('../techniques/tools.js')` calls, unchanged. Re-derived here as
// the brief requires: `techniques/tools.ts` imports nothing from the toolbox,
// so no cycle is left for them to break — a measurement handed up, not acted
// on, because converting them would be an improvement taken during a move.
//
// ── THE LAZY LOADS THAT DIED, EACH MEASURED FIRST ──
// `../techniques/store.js` (×2), `../techniques/versioning.js` and
// `../config/platform.js` are NOT on the sanctioned list, and none of the three
// modules imports anything from the toolbox, so none broke a cycle. Static now.
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from '../../../db/connection.js';
import { deleteTechnique, getTechnique, resolveTechniqueRef } from '../../../techniques/store.js';
import { listDiskVersions, backfillDiskVersionsFromDb } from '../../../techniques/versioning.js';
import {
  isTrainerAgent as isTrainer, isTrainerEnabled, getTrainerAgentName, getTrainerAgentId,
} from '../../../config/platform.js';
import { toolsLogger as logger } from '../util.js';
import type { ToolHandlerMap } from '../handler.js';

export const techniqueHandlers: ToolHandlerMap = {
  async save_technique({ agentId, args }) {
    const { executeSaveTechnique } = await import('../../../techniques/tools.js');
    const agentRow = getDb().prepare('SELECT name, classification FROM agents WHERE id = ?').get(agentId) as { name: string; classification: string } | undefined;
    const content = executeSaveTechnique(agentId, agentRow?.name ?? agentId, agentRow?.classification ?? 'apprentice', args);
    return { content, isError: content.startsWith('Error') || content.startsWith('Only') };
  },

  async use_technique({ agentId, args }) {
    // v2.5.44, use_technique now redirects to technique_read(outline).
    // Old behavior dumped the entire TECHNIQUE.md into the result and
    // truncated past 72K chars, which caused agents to either flounder
    // on huge techniques or fall back to memory. New behavior returns
    // the outline + a hint to call technique_read for specific parts.
    // Existing callers keep working with safer semantics.
    const { executeTechniqueRead } = await import('../../../techniques/tools.js');
    const agentRow2 = getDb().prepare('SELECT name, group_id FROM agents WHERE id = ?').get(agentId) as { name: string; group_id: string | null } | undefined;
    const content = executeTechniqueRead(
      agentId,
      agentRow2?.name ?? agentId,
      agentRow2?.group_id ?? null,
      { name: args.name, action: 'outline' },
    );
    return { content, isError: content.startsWith('Error') };
  },

  async technique_read({ agentId, args }) {
    const { executeTechniqueRead } = await import('../../../techniques/tools.js');
    const trRow = getDb().prepare('SELECT name, group_id FROM agents WHERE id = ?').get(agentId) as { name: string; group_id: string | null } | undefined;
    const content = executeTechniqueRead(
      agentId,
      trRow?.name ?? agentId,
      trRow?.group_id ?? null,
      args,
    );
    return { content, isError: content.startsWith('Error') };
  },

  async list_techniques({ agentId, args }) {
    const { executeListTechniques } = await import('../../../techniques/tools.js');
    const agentRow3 = getDb().prepare('SELECT classification FROM agents WHERE id = ?').get(agentId) as { classification: string } | undefined;
    // NOTE (relocation): this case set `content` and did NOT set `isError` —
    // `list_techniques` is the one technique verb whose result is never graded
    // by prose. Preserved exactly; grading it here would be a new refusal.
    return { content: executeListTechniques(agentId, agentRow3?.classification ?? 'apprentice', args), isError: false };
  },

  async technique_acknowledge({ agentId, args }) {
    // Pull the current pending-ack from agents.config and dispatch
    // to the validator. On success, clear the persisted ack so the
    // gate releases. The runtime in v2/loop.ts re-reads config at
    // its gate check, so clearing here is sufficient, no need to
    // mutate state.pendingTechniqueAck directly (we don't have
    // that state in this scope).
    const { executeTechniqueAcknowledge } = await import('../../../techniques/tools.js');
    const taDb = getDb();
    const taRow = taDb.prepare('SELECT config FROM agents WHERE id = ?').get(agentId) as { config: string } | undefined;
    const taCfg = taRow?.config ? JSON.parse(taRow.config) as Record<string, unknown> : {};
    const pending = (taCfg.pendingTechniqueAck ?? null) as { techniqueId: string; techniqueName: string } | null;
    const result = executeTechniqueAcknowledge(agentId, pending, args);
    if (result.ok && result.clearedAck) {
      delete taCfg.pendingTechniqueAck;
      taDb.prepare("UPDATE agents SET config = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(taCfg), agentId);
    }
    return { content: result.content, isError: !result.ok };
  },

  async publish_technique({ agentId, args }) {
    const { executePublishTechnique } = await import('../../../techniques/tools.js');
    const agentRow4 = getDb().prepare('SELECT classification FROM agents WHERE id = ?').get(agentId) as { classification: string } | undefined;
    const content = executePublishTechnique(agentId, agentRow4?.classification ?? 'apprentice', args);
    return { content, isError: content.startsWith('Error') || content.startsWith('Only') };
  },

  async update_technique({ agentId, args }) {
    const { executeUpdateTechnique } = await import('../../../techniques/tools.js');
    const agentRow5 = getDb().prepare('SELECT name, classification FROM agents WHERE id = ?').get(agentId) as { name: string; classification: string } | undefined;
    const content = executeUpdateTechnique(agentId, agentRow5?.name ?? agentId, agentRow5?.classification ?? 'apprentice', args);
    return { content, isError: content.startsWith('Error') || content.startsWith('Only') };
  },

  async submit_technique_for_review({ agentId, args }) {
    const { executeSubmitForReview } = await import('../../../techniques/tools.js');
    const sfrRow = getDb().prepare('SELECT classification FROM agents WHERE id = ?').get(agentId) as { classification: string } | undefined;
    const content = executeSubmitForReview(agentId, sfrRow?.classification ?? 'apprentice', args);
    return { content, isError: content.startsWith('Error') };
  },

  async delete_technique({ agentId, args }) {
    // Trainer-only, same ownership rule as save/update/publish.
    // Mirror the executor-side fallback in techniques/tools.ts so a
    // trainer-disabled install doesn't lose delete capability.
    if (!isTrainer(agentId)) {
      const dtAgentRow = getDb().prepare('SELECT classification FROM agents WHERE id = ?').get(agentId) as { classification: string } | undefined;
      const dtAgentClass = dtAgentRow?.classification ?? 'apprentice';
      const trainerLive = (() => {
        try {
          const r = getDb().prepare("SELECT status FROM agents WHERE id = ?").get(getTrainerAgentId()) as { status: string } | undefined;
          return !!r && r.status !== 'terminated';
        } catch { return false; }
      })();
      const fallback = !isTrainerEnabled() || !trainerLive;
      if (fallback) {
        if (dtAgentClass !== 'sensei') {
          return { content: 'Refused: delete_technique is restricted to Sensei agents (no live trainer on this install).', isError: true };
        }
        // Allowed via fallback.
      } else {
        return {
          content: (
            `Refused: delete_technique is reserved for the trainer agent (${getTrainerAgentName()}). ` +
            `Ask ${getTrainerAgentName()} to delete it on your behalf.`
          ),
          isError: true,
        };
      }
    }
    const techRef = args.name as string;
    const dtResolved = resolveTechniqueRef(techRef);
    if (!dtResolved.ok) { return { content: dtResolved.error, isError: true }; }
    const deleted = deleteTechnique(dtResolved.id);
    if (deleted) {
      logger.info('Technique deleted via tool', { techniqueId: dtResolved.id }, agentId);
      return { content: `Technique "${techRef}" has been permanently deleted.`, isError: false };
    }
    return { content: `Error: technique "${techRef}" could not be deleted.`, isError: true };
  },

  async technique_set_placeholder({ agentId, args }) {
    const { executeTechniqueSetPlaceholder } = await import('../../../techniques/tools.js');
    const tspRow = getDb().prepare('SELECT classification FROM agents WHERE id = ?').get(agentId) as { classification: string } | undefined;
    const content = executeTechniqueSetPlaceholder(agentId, tspRow?.classification ?? 'apprentice', args);
    return { content, isError: content.startsWith('Error') };
  },

  async technique_finalize({ agentId, args }) {
    const { executeTechniqueFinalize } = await import('../../../techniques/tools.js');
    const tfRow = getDb().prepare('SELECT classification FROM agents WHERE id = ?').get(agentId) as { classification: string } | undefined;
    const content = executeTechniqueFinalize(agentId, tfRow?.classification ?? 'apprentice', args);
    return { content, isError: content.startsWith('Error') };
  },

  async technique_list_versions({ args }) {
    const techRef = args.name as string;
    const tlvResolved = resolveTechniqueRef(techRef);
    if (!tlvResolved.ok) { return { content: tlvResolved.error, isError: true }; }
    const techName = tlvResolved.id;
    const tech = getTechnique(techName);
    if (!tech) { return { content: `Error: technique "${techRef}" not found.`, isError: true }; }
    let versions = listDiskVersions(tech.directoryPath);
    if (versions.length === 0) {
      // First call after upgrading to v1.15.97, hydrate disk from the
      // DB so techniques that pre-date the disk-snapshot system still
      // expose their history through file_read.
      const written = backfillDiskVersionsFromDb(techName, tech.directoryPath);
      if (written > 0) {
        versions = listDiskVersions(tech.directoryPath);
      }
    }
    if (versions.length === 0) {
      return {
        content: `Technique "${techName}" has no version snapshots yet. The first snapshot is written on the next update_technique call.`,
        isError: false,
      };
    }
    const lines = versions.map(v =>
      `v${v.versionNumber}, ${v.createdAt ?? 'unknown date'} by ${v.changedBy ?? 'unknown'}: ${v.changeSummary ?? '(no summary)'}\n  file: ${v.filePath} (${v.sizeBytes} bytes)`,
    );
    return {
      content: `Technique "${techName}", ${versions.length} version(s) on disk (newest first):\n\n${lines.join('\n\n')}\n\nUse file_read with the listed paths to view any prior version. Current TECHNIQUE.md (latest version) is at ${tech.directoryPath}/TECHNIQUE.md.`,
      isError: false,
    };
  },
};
