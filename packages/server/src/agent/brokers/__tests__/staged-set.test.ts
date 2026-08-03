// ════════════════════════════════════════════════════════════════════════════
// THE STAGED SET, RE-DERIVED FROM THE BROKERS THEMSELVES (PHASE-5 T5, P5-R6).
//
// `ladder-rows.test.ts` already holds `logOnly`'s SHAPE, using synthetic
// verdicts it builds itself. That is necessary and it is not sufficient: it can
// only prove the predicate answers correctly about a verdict handed to it, never
// that the verdicts the brokers ACTUALLY produce stay out of the window. T2
// recorded the staged set as EMPTY; nothing held it empty.
//
// This file is that holder. It asks each broker for a real refusal and asserts
// the answer is ENFORCED for a sub-agent. RULING P5-R6 is the requirement:
//
//   "a global deny is NEVER staged; a `ladder-parity` refusal is NEVER staged
//    for sub-agents. The staged set must not widen, here or ever."
//
// ⚠ WHY THIS FILE EXISTS RATHER THAN A COMMENT: the set HAD widened. Between
// T2's measurement and this task the AppleScript broker gained a refusal that
// enforces the sensitive-files block list against a `do shell script` payload,
// and it carried a rule id `isGlobalDenyRule` did not recognise — so for a
// sub-agent it was recorded and not applied. That is the same shape as the
// defect T3 fixed one line above for the exec family, and the same shape as the
// incident that earned P5-R6. Detail is in `.superpowers/sdd/PHASE-5/
// task-T5-report.md` §2, cited rather than repeated here.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { authorizeAppleScript } from '../applescript.js';
import { authorizeShellScript, authorizeArgv } from '../proc.js';
import { grantForManifest } from '../grants.js';
import { isGlobalDenyRule } from '../deny.js';
import { resolveCommandArg, resolveArgvArg } from '../resolve.js';
import { DEFAULT_SUBAGENT_PERMISSIONS, PRIMARY_AGENT_PERMISSIONS } from '../../manifest.js';
import type { Verdict } from '../types.js';

/**
 * `logOnly`'s predicate for a SUB-AGENT, restated here from its three parts.
 *
 * Deliberately not imported: `gate-eval.js` pulls the registry and with it the
 * whole handler graph, and this file is about the brokers. The identity half
 * (`isPrimaryAgent || isHealerAgent`) is false for a sub-agent by definition, so
 * what is left is exactly these three terms. `ladder-rows.test.ts` holds the
 * imported function's own shape; this holds what the brokers feed it.
 */
function stagedForSubAgent(v: Verdict): boolean {
  if (v.allowed) return false;
  if (v.basis === 'ladder-parity') return false;
  return !isGlobalDenyRule(v.rule);
}

/** A sub-agent with the stock default manifest — no applescript grant at all. */
const subAgent = grantForManifest('sub-agent-1', DEFAULT_SUBAGENT_PERMISSIONS);
/** A `'*'` holder, which is how the primary and the two live `'*'` sub-agents read. */
const wildcard = grantForManifest('sub-agent-star', PRIMARY_AGENT_PERMISSIONS);

function applescript(grant: ReturnType<typeof grantForManifest>, script: string): Verdict {
  const resolved = resolveCommandArg(script);
  if (!resolved.ok) throw new Error(`fixture did not resolve: ${script}`);
  return authorizeAppleScript(grant, resolved.value);
}

function shell(grant: ReturnType<typeof grantForManifest>, script: string): Verdict {
  const resolved = resolveCommandArg(script);
  if (!resolved.ok) throw new Error(`fixture did not resolve: ${script}`);
  return authorizeShellScript(grant, resolved.value);
}

// The four sensitive families the block list names, one path each. These are
// PATH tests — `isSensitivePath` never opens a file — so no fixture has to exist
// and nothing is read by running this suite.
const SENSITIVE_PAYLOADS: ReadonlyArray<readonly [string, string]> = [
  ['ssh private key', 'cat ~/.ssh/id_rsa'],
  ['aws credentials', 'cat ~/.aws/credentials'],
  ['dotenv file', 'cat /tmp/.env'],
  ['gcloud config', 'cat ~/.config/gcloud/credentials.db'],
];

describe('P5-R6 — the staged set, derived from the brokers rather than declared', () => {
  it('the AppleScript door NEVER stages a sensitive-read refusal for a sub-agent', () => {
    // THE CLAUSE THAT WAS RED. Each of these is the global sensitive-files block
    // list being enforced against a `do shell script` payload — the shell door's
    // own rule, reached through a second interpreter. A refusal that recorded
    // itself and let the script run is the P5-R6 incident class exactly.
    for (const [label, payload] of SENSITIVE_PAYLOADS) {
      const verdict = applescript(subAgent, `do shell script "${payload}"`);
      expect(verdict.allowed, `${label}: must be refused`).toBe(false);
      expect(
        stagedForSubAgent(verdict),
        `${label}: refusal ${verdict.rule} must be ENFORCED for a sub-agent, never staged`,
      ).toBe(false);
    }
  });

  it('the same payload at the SHELL door was always enforced — the two doors now agree', () => {
    // The asymmetry is the whole finding: identical requirement, identical
    // payload, one door enforced it and the other recorded it. This clause is
    // what keeps them from drifting apart again.
    for (const [label, payload] of SENSITIVE_PAYLOADS) {
      const shellVerdict = shell(subAgent, payload);
      const scriptVerdict = applescript(subAgent, `do shell script "${payload}"`);
      expect(shellVerdict.allowed, `${label}: shell door must refuse`).toBe(false);
      expect(stagedForSubAgent(shellVerdict), `${label}: shell door must enforce`).toBe(false);
      expect(scriptVerdict.allowed, `${label}: applescript door must refuse`).toBe(false);
      expect(stagedForSubAgent(scriptVerdict), `${label}: applescript door must enforce`).toBe(false);
    }
  });

  it('a `\'*\'`-holding agent is refused the same payload — the grant is not the escape', () => {
    // The staging bug also short-circuited the GRANT wall: the payload scan runs
    // before the grant rows are read, so the staged verdict returned before
    // `no-applescript-grant` could. Holding a grant must not change the answer
    // either — the block list is unoverridable by construction.
    for (const [label, payload] of SENSITIVE_PAYLOADS) {
      const verdict = applescript(wildcard, `do shell script "${payload}"`);
      expect(verdict.allowed, `${label}: a '*' holder is still refused`).toBe(false);
      expect(stagedForSubAgent(verdict), `${label}: and still enforced`).toBe(false);
    }
  });

  it('the secrets.yaml substring rule was already enforced, and stays that way', () => {
    // The one payload that was NEVER staged, because the whole-body substring
    // rule catches it with a `global-exec-*` id the predicate already knew. It
    // is the negative control: it proves the fix did not simply blanket
    // everything, because this row's answer is unchanged.
    const verdict = applescript(subAgent, 'do shell script "cat ~/.dojo/secrets.yaml"');
    expect(verdict.allowed).toBe(false);
    expect(verdict.basis).toBe('ladder-parity');
    expect(stagedForSubAgent(verdict)).toBe(false);
  });

  it('an ordinary grant refusal still reads as the GRANT refusing, not the block list', () => {
    // The preserved-capability half. A benign script from an agent with no
    // applescript grant must still answer `no-applescript-grant` — if the fix
    // had been "call everything a global deny" this clause would fail, and the
    // refusal a model reads would have changed meaning.
    const verdict = applescript(subAgent, 'display dialog "hello"');
    expect(verdict.allowed).toBe(false);
    expect(verdict.rule).toBe('no-applescript-grant');
    expect(verdict.basis).toBe('ladder-parity');
  });

  it('a benign script from a `\'*\'` holder is ALLOWED — the fix refuses nothing extra', () => {
    // The positive test the phase's posture requires beside every refusal.
    const verdict = applescript(wildcard, 'display dialog "hello"');
    expect(verdict.allowed, 'a wildcard holder keeps its AppleScript reach').toBe(true);
  });

  it('the argv door’s sensitive-read refusal is enforced too', () => {
    // Enumerated for completeness: `exec-sensitive-read` is the third spelling
    // of the same requirement and it must answer the same way.
    const resolved = resolveArgvArg(['cat', '/tmp/.env']);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const verdict = authorizeArgv(subAgent, resolved.value);
    expect(verdict.allowed).toBe(false);
    expect(stagedForSubAgent(verdict)).toBe(false);
  });
});
