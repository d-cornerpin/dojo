// OR-ENGINE-LABELLED, whole-branch sweep: every engine-written text a person can read is the Dojo speaking, never "I".
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { formatErrorForHuman } from '../error-format.js';
import { engineRelayPreface } from '../../../work/join-drive.js';
import { declaredPatienceHonestFailNote } from '../recovery.js';
import { stuckWords } from '../../../healer/owner-notices.js';

const FIRST_PERSON = /\bI\b|\bI'll\b|\bI've\b|\bI'm\b|\bmy\b|\bme\b/i;
const SRC = path.resolve(__dirname, '..', '..', '..');

describe('engine texts to people carry no first person', () => {
  it('formatErrorForHuman (owner cards)', () => {
    for (const k of ['no_models_available', 'all_providers_down', 'dns_failure'] as const) {
      const t = formatErrorForHuman(k, { agentName: 'Quill' });
      expect(t, k).not.toMatch(FIRST_PERSON);
    }
    expect(formatErrorForHuman('all_providers_down')).toContain('The Dojo will keep trying every 5 minutes');
  });
  it('the engine relay preface (sent with the "Dojo:" label)', () => {
    expect(engineRelayPreface(2)).toBe('Both results are in as the helpers delivered them; they were not combined, so here they are in full:');
    expect(engineRelayPreface(4)).not.toMatch(FIRST_PERSON);
  });
  it('the honest-fail note starts "Dojo:" in both variants', () => {
    for (const compacted of [true, false]) {
      const t = declaredPatienceHonestFailNote('pull the Q3 deck together', compacted);
      expect(t).toMatch(/^Dojo: the agent couldn't finish answering/);
      expect(t.replace(/"[^"]*"/g, '')).not.toMatch(FIRST_PERSON);
    }
  });
  it('the Healer stuck notice', () => {
    expect(stuckWords('Quill')).not.toMatch(FIRST_PERSON);
    expect(stuckWords('Quill')).toContain('The Dojo will keep trying in the background.');
  });
  it('the expired-approval owner note is the Dojo, and the agent is told what it said', () => {
    const src = fs.readFileSync(path.join(SRC, 'agent/destructive-gate.ts'), 'utf8');
    expect(src).not.toContain('asked me to approve');
    expect(src).toContain('OWNER_ALERT_DOJO_PREFIX} "${name}" asked for approval');
    expect(src).toMatch(/tellAgentWhatDojoSent\(\{ agentId: primaryId/);
  });
  it('the honest-fail and size-limit notes tell the agent after posting', () => {
    const src = fs.readFileSync(path.join(SRC, 'agent/v2/recovery.ts'), 'utf8');
    expect(src).toMatch(/persistAndBroadcastSystemNote\(agentId, honestFail\);\s*\n\s*tellAgentWhatDojoSent\(/);
    expect(src).not.toContain("I hit my model's size limit");
  });
});
