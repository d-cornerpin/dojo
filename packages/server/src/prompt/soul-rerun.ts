import { writeSoulFile, soulFileForAgent, readSoulFile, type AgentSoulFile } from './assembler.js';
import { composePrimarySoul } from './oobe-soul.js';
import { DEFAULT_SOUL_MD } from './templates.js';
import { getPrimaryAgentId } from '../config/platform.js';

export interface SoulRerunOutcome { written: boolean; backup: string | null }

/**
 * Setup re-run over an existing primary soul: an absent or default soul is composed freely; an edited one
 * is kept unless the style changed, and then it is first backed up beside itself. File work uses the soul door.
 */
export function writeSoulOnRerun(soul: AgentSoulFile, composed: string, pastFirstRun: boolean, restyle: boolean): SoulRerunOutcome {
  const stored = readSoulFile(soul);
  const edited = pastFirstRun && stored.trim() !== '' && stored !== soul.fallback;
  if (!edited) { writeSoulFile(soul, composed); return { written: true, backup: null }; }
  if (!restyle || stored === composed) return { written: false, backup: null };
  const backup = `${soul.file}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
  writeSoulFile({ ...soul, file: backup }, stored);
  writeSoulFile(soul, composed);
  return { written: true, backup };
}

export function writeOobeSoul(fields: { communicationStyle: string; rules: string }, pastFirstRun: boolean, restyle: boolean): { soul: string; backup: string | null } {
  const primarySoul = soulFileForAgent(getPrimaryAgentId());
  const composed = composePrimarySoul(fields, primarySoul?.fallback || DEFAULT_SOUL_MD);
  const target = primarySoul ?? { file: 'SOUL.md', fallback: '', spawnTruth: true };
  if (!primarySoul) { writeSoulFile(target, composed); return { soul: composed, backup: null }; }
  const out = writeSoulOnRerun(primarySoul, composed, pastFirstRun, restyle);
  return { soul: out.written ? composed : readSoulFile(primarySoul), backup: out.backup };
}
