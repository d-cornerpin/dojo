import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from '../home.js';
import { writeSoulFile, soulFileForAgent, readSoulFile, type AgentSoulFile } from './assembler.js';
import { composePrimarySoul } from './oobe-soul.js';
import { DEFAULT_SOUL_MD } from './templates.js';
import { getPrimaryAgentId } from '../config/platform.js';

export interface SoulRerunOutcome { written: boolean; backup: string | null }

/**
 * Setup re-run over an existing primary soul. A soul that is absent or still the shipped default
 * is composed freely. A soul a person has edited is left byte-identical unless the owner changed
 * the style or rules in this run; then the previous text is copied to a dated file beside it
 * first, and its name is returned so the step can say where it went.
 */
export function writeSoulOnRerun(soul: AgentSoulFile, composed: string, pastFirstRun: boolean, restyle: boolean): SoulRerunOutcome {
  const PROMPTS_DIR = path.join(homeDir(), '.dojo', 'prompts');
  const file = path.join(PROMPTS_DIR, soul.file);
  let stored: string | null = null;
  try { stored = fs.readFileSync(file, 'utf-8'); } catch { /* absent */ }
  const edited = pastFirstRun && stored !== null && stored.trim() !== '' && stored !== soul.fallback;
  if (!edited) { writeSoulFile(soul, composed); return { written: true, backup: null }; }
  if (!restyle || stored === composed) return { written: false, backup: null };
  const backup = `${soul.file}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
  fs.writeFileSync(path.join(PROMPTS_DIR, backup), stored!, 'utf-8');
  writeSoulFile(soul, composed);
  return { written: true, backup };
}

/** The setup door's whole soul step: compose from the wizard's fields and write it by the rules above. */
export function writeOobeSoul(fields: { communicationStyle: string; rules: string }, pastFirstRun: boolean, restyle: boolean): { soul: string; backup: string | null } {
  const primarySoul = soulFileForAgent(getPrimaryAgentId());
  const composed = composePrimarySoul(fields, primarySoul?.fallback || DEFAULT_SOUL_MD);
  if (!primarySoul) {
    const dir = path.join(homeDir(), '.dojo', 'prompts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SOUL.md'), composed, 'utf-8');
    return { soul: composed, backup: null };
  }
  const out = writeSoulOnRerun(primarySoul, composed, pastFirstRun, restyle);
  return { soul: out.written ? composed : readSoulFile(primarySoul), backup: out.backup };
}
