// ════════════════════════════════════════════════════════════════════════════
// EVERY DASHBOARD EDITOR THAT READS A VALUE AND WRITES IT BACK CONSULTS THE LOAD GUARD.
//
// The rule (lib/load-guard.ts): an editor may only save on top of a value that was successfully read for
// the thing on screen. This test pins it two ways.
//   1. GUARDED lists every editor that must carry the guard, and checks the file still does.
//   2. Any other non-test file that writes a stored value (setSetting / updateIdentity / updateAgentConfig /
//      the config setters / briefing / thresholds) must be named in REVIEWED with the reason it needs no
//      guard. A new editor that saves without either fails here until someone classifies it.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..');
const GUARD_MARKERS = /useGuardedLoad|useRequestGuard|LoadGate|SetupLoadFailed|loadFailed|useWarningThreshold/;

/** Editors that read, hold, and write back. Each must show the guard's marker. */
const GUARDED = [
  'components/ChannelSafeSenders.tsx',        // channel safe-sender lists (Gmail / Outlook / Teams)
  'components/settings/IMBridgeSettings.tsx', // iMessage approved senders + switch
  'pages/Setup.tsx',                          // wizard steps: iMessage, profile, primary, PM, trainer, dreamer
  'pages/AgentConfigPanel.tsx',               // the system prompt (SOUL.md for the primary)
  'components/BriefingView.tsx',              // the briefing
  'components/TechniqueSessionProvider.tsx',  // the Technique Mat
  'components/AccessPanel.tsx',               // tool groups and connected accounts
  'components/settings/ProfileTab.tsx',       // name and USER.md
  'components/settings/DreamingTab.tsx',
  'components/settings/CapabilityModelCards.tsx', // Healer card and the model-pick cards
  'components/settings/PlatformTab.tsx',      // Ollama, capacity limits, search
  'components/settings/VoiceTab.tsx',
  'pages/Costs.tsx',                          // the two warning thresholds
];

/** Files that write a stored value but need no guard, with the reason. */
const REVIEWED: Record<string, string> = {
  'components/AgentCard.tsx': 'writes one explicit colour pick; reads nothing back',
  'components/QuietTimeCard.tsx': 'edits a value of the agent the parent already loaded successfully; the whole page is gated on that load',
  'components/RouterConfig.tsx': 'writes only on an explicit model pick or clear',
  'components/settings/RouterWindowSection.tsx': 'writes one explicit slider choice and reverts on refusal',
  'components/VoiceSetupStep.tsx': 'writes only on an explicit voice pick',
  'components/orb/orbQuality.ts': 'best-effort preference write of an explicit choice',
  'components/settings/SecurityTab.tsx': 'one explicit policy switch (its own failed-save display is a separate task)',
};

const WRITES = /setSetting\(|updateIdentity\(|updateAgentConfig\(|updateDreamingConfig\(|updateHealerConfig\(|setSearchConfig\(|updateBriefing\(|\/threshold'/;

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === '__tests__' ? [] : walk(path.join(dir, e.name))) : [path.join(dir, e.name)]);

describe('editors that save', () => {
  it('every guarded editor still carries the load guard', () => {
    for (const f of GUARDED) {
      const text = fs.readFileSync(path.join(SRC, f), 'utf8');
      expect(GUARD_MARKERS.test(text), `${f} lost its load guard`).toBe(true);
    }
  });

  it('every other file that writes a stored value is reviewed', () => {
    const unknown = walk(SRC)
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .map((f) => path.relative(SRC, f))
      .filter((f) => f !== 'lib/api.ts' && !GUARDED.includes(f) && !(f in REVIEWED))
      .filter((f) => WRITES.test(fs.readFileSync(path.join(SRC, f), 'utf8')));
    expect(unknown, 'a file saves a stored value but is in neither GUARDED nor REVIEWED').toEqual([]);
  });

  it('the reviewed list holds no file that no longer exists or no longer writes', () => {
    for (const f of Object.keys(REVIEWED)) {
      const full = path.join(SRC, f);
      expect(fs.existsSync(full), `${f} is gone`).toBe(true);
      expect(WRITES.test(fs.readFileSync(full, 'utf8')), `${f} no longer writes; drop it from REVIEWED`).toBe(true);
    }
  });
});
