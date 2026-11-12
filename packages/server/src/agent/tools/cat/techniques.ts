// TECHNIQUES: the twelve tools `tools/categories.ts` files under "Techniques".
// The bodies are the old switch bodies, unchanged, keeping the per-case row
// names (`agentRow2`, `taRow`, ...) that only existed because twelve cases
// shared one function scope.
// The nine `techniques/tools.js` lazy loads are kept deliberately: that module
// imports nothing from the toolbox and they belong with their handlers. The
// other lazy loads became static imports after measuring no cycle existed.

import { getDb } from '../../../db/connection.js';
import { deleteTechnique, getTechnique, resolveTechniqueRef } from '../../../techniques/store.js';
import { listDiskVersions, backfillDiskVersionsFromDb } from '../../../techniques/versioning.js';
import {
  isTrainerAgent as isTrainer, getTrainerAgentName, getTrainerAgentId,
} from '../../../config/platform.js';
import { toolsLogger as logger } from '../util.js';
import type { ToolHandlerMap } from '../handler.js';

/** A technique write that did not happen. The write functions return plain refusal text, not always starting "Error". */
const TECHNIQUE_WRITE_FAILED = /^(Error|Only|Refused|Technique ".*" not found|Technique ".*" is not in draft state)/;

export const techniqueHandlers: ToolHandlerMap = {
  async save_technique({ agentId, args }) {
    const { executeSaveTechnique } = await import('../../../techniques/tools.js');
    const agentRow = getDb().prepare('SELECT name, classification FROM agents WHERE id = ?').get(agentId) as { name: string; classification: string } | undefined;
    const content = executeSaveTechnique(agentId, agentRow?.name ?? agentId, agentRow?.classification ?? 'apprentice', args);
    return { content, isError: TECHNIQUE_WRITE_FAILED.test(content) };
  },

  async use_technique({ agentId, args }) {
    // Returns the outline plus a hint to technique_read for specific parts,
    // not the whole document: huge dumps made agents flounder or memorize.
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
    // The one technique verb whose result is never graded by prose, and
    // grading it here would be a new refusal. Preserved exactly.
    return { content: executeListTechniques(agentId, agentRow3?.classification ?? 'apprentice', args), isError: false };
  },

  async technique_acknowledge({ agentId, args }) {
    // Read the pending-ack from agents.config, dispatch to the validator,
    // and on success clear the persisted ack so the gate releases. The
    // runtime re-reads config at its gate check, so clearing there suffices.
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
    return { content, isError: TECHNIQUE_WRITE_FAILED.test(content) };
  },

  async update_technique({ agentId, args }) {
    const { executeUpdateTechnique } = await import('../../../techniques/tools.js');
    const agentRow5 = getDb().prepare('SELECT name, classification FROM agents WHERE id = ?').get(agentId) as { name: string; classification: string } | undefined;
    const content = executeUpdateTechnique(agentId, agentRow5?.name ?? agentId, agentRow5?.classification ?? 'apprentice', args);
    return { content, isError: TECHNIQUE_WRITE_FAILED.test(content) };
  },

  async submit_technique_for_review({ agentId, args }) {
    const { executeSubmitForReview } = await import('../../../techniques/tools.js');
    const sfrRow = getDb().prepare('SELECT classification FROM agents WHERE id = ?').get(agentId) as { classification: string } | undefined;
    const content = executeSubmitForReview(agentId, sfrRow?.classification ?? 'apprentice', args);
    return { content, isError: TECHNIQUE_WRITE_FAILED.test(content) };
  },

  async delete_technique({ agentId, args }) {
    // Trainer-only, same ownership rule as save/update/publish.
    // With no live trainer a sensei may delete (same fallback as techniques/tools.ts).
    if (!isTrainer(agentId)) {
      const dtAgentRow = getDb().prepare('SELECT classification FROM agents WHERE id = ?').get(agentId) as { classification: string } | undefined;
      const dtAgentClass = dtAgentRow?.classification ?? 'apprentice';
      const trainerLive = (() => {
        try {
          const r = getDb().prepare("SELECT status FROM agents WHERE id = ?").get(getTrainerAgentId()) as { status: string } | undefined;
          return !!r && r.status !== 'terminated';
        } catch { return false; }
      })();
      if (!trainerLive) {
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
    return { content, isError: TECHNIQUE_WRITE_FAILED.test(content) };
  },

  async technique_finalize({ agentId, args }) {
    const { executeTechniqueFinalize } = await import('../../../techniques/tools.js');
    const tfRow = getDb().prepare('SELECT classification FROM agents WHERE id = ?').get(agentId) as { classification: string } | undefined;
    const content = executeTechniqueFinalize(agentId, tfRow?.classification ?? 'apprentice', args);
    return { content, isError: TECHNIQUE_WRITE_FAILED.test(content) };
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
      // Hydrate the disk from the DB so techniques that pre-date the
      // disk-snapshot system still expose their history through file_read.
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
