// Leaf reader for generated tool docs, so a dispatch that wants one file does not import the generator
// (which imports the whole tool registry). `TOOLS_DIR` is owned here and the generator imports it.

import path from 'node:path';
import * as effectFs from '../agent/effects/fs.js';
import { homeDir } from '../home.js';

export const TOOLS_DIR = path.join(homeDir(), '.dojo', 'tools');

export function getToolsDir(): string {
  return TOOLS_DIR;
}

export function readToolDoc(toolName: string): string | null {
  const filePath = path.join(TOOLS_DIR, `${toolName}.md`);
  if (!effectFs.existsSync(filePath)) return null;
  try {
    return effectFs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}
