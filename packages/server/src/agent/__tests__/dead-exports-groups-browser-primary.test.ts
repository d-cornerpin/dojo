// THREE EXPORTS THAT NOBODY CALLED — read out of the source tree, not imported,
// so this file holds their ABSENCE (and the live neighbours' presence) as a
// permanent fact about the files themselves. A dead export is not free: it reads
// as API, and the next reader spends a search deciding whether to use it.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const groupsSrc = fs.readFileSync(path.join(AGENT_DIR, 'groups.ts'), 'utf8');
const browserSrc = fs.readFileSync(path.join(AGENT_DIR, 'browser.ts'), 'utf8');
const primaryReadySrc = fs.readFileSync(path.join(AGENT_DIR, 'primary-ready.ts'), 'utf8');

describe('dead exports are gone from the groups/browser/primary-ready trio', () => {
  it('groups.ts no longer holds canMessageInGroup', () => {
    expect(groupsSrc).not.toContain('canMessageInGroup');
  });

  it('browser.ts no longer holds closeAllSessions', () => {
    expect(browserSrc).not.toContain('closeAllSessions');
  });

  it('primary-ready.ts no longer holds forgetPrimaryWait', () => {
    expect(primaryReadySrc).not.toContain('forgetPrimaryWait');
  });

  it('the live neighbours each deletion sat beside are still exported', () => {
    expect(browserSrc).toContain('export async function closeSession');
    expect(browserSrc).toContain('export function getOrCreateSession');
    expect(groupsSrc).toContain('export function assignAgentToGroup');
    expect(primaryReadySrc).toContain('export function primaryReady');
  });
});
