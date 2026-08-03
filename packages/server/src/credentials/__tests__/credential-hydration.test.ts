// ════════════════════════════════════════════════════════════════════════════
// THE CREDENTIAL-USABILITY SEAM (PHASE-5 T6B, RULING P5-R11).
//
// ── THE REQUIREMENT, IN THE OWNER'S OWN TERMS ───────────────────────────────
// A credential the platform stores must stay usable by the agent for the WHOLE
// turn, not only its first use — and when the real value is no longer held in
// memory, what the agent reads must SAY SO: it tells the agent to fetch the
// credential again rather than hand a dead value forward.
//
// ── WHAT WAS BROKEN, MEASURED RATHER THAN SUSPECTED ─────────────────────────
// PHASE-4 T5b redacts a handed credential out of every copy the platform
// STORES. `assembleContext` then rebuilds the model's message array from those
// stored rows on EVERY tool-loop iteration — so from the second iteration on,
// the model is shown its own previous call with the placeholder where the value
// was, and it copies the placeholder into the next command. The capability
// worked once per turn and silently stopped working after that. Reproduced at
// PHASE-5 T6 and again, independently, at T6B: three sequential `exec` calls in
// one turn, the first receiving the real value and the rest the placeholder.
// The drive record is in `.superpowers/sdd/PHASE-5/task-T6B-report.md` §2 —
// cited, never repeated, and no secret value appears in it or here.
//
// ── THE SHAPE OF THE FIX, AND WHY EACH HALF IS HERE ─────────────────────────
// The stored row keeps a placeholder; the value is put back only where the
// agent READS, only from the value THIS PROCESS is already holding, and only
// for the agent that fetched it. Three properties make that safe rather than
// lucky, and all three are clauses below:
//
//   1. THE PLACEHOLDER IDENTIFIES WHICH VALUE IT REPLACED. An opaque
//      `<redacted-credential>` cannot be put back correctly once an agent holds
//      two secrets — guessing between them is worse than not restoring at all.
//      The handle is an in-process COUNTER, deliberately NOT derived from the
//      value: a truncated digest of a secret sitting at rest is a (weak) oracle
//      on that secret, and a counter is not.
//   2. A DEAD VALUE IS NEVER PRESENTABLE AS A LIVE ONE. After a restart the
//      in-process set is empty, so nothing can be restored; what the agent then
//      reads is self-describing and names the way out (`credential_get`).
//      The same is true of the untagged placeholder written by every release
//      before this one — history is never rewritten, so those rows still exist
//      and they are read out as stale, not as live.
//   3. WITH NO CREDENTIAL IN FLIGHT THE MESSAGE ARRAY IS THE ASSEMBLER'S OWN
//      ARRAY, BY REFERENCE. That is the cache-preservation tenet (OR7 /
//      roadmap #10) held structurally: the two golden reference files cannot
//      move because of a seam that provably does nothing when no placeholder is
//      present. Asserted here, not observed once.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REDACTED_CREDENTIAL,
  CREDENTIAL_STALE_PLACEHOLDER,
  noteHandedCredentialValues,
  redactHandedCredentials,
  redactedPlaceholderFor,
  hydrateHandedCredentials,
  hydrateCredentialsInMessages,
  forgetHandedCredentialValues,
} from '../secret-values.js';

const AGENT = 'agent-hydration-a';
const OTHER = 'agent-hydration-b';
// Test material only. Never a real credential, and no real value appears in any
// test, commit or report in this project — comparisons are by digest there.
const SECRET = 'sk-t6b-unit-abcdef0123456789';
const SECOND = 'sk-t6b-unit-9876543210fedcba';

beforeEach(() => {
  forgetHandedCredentialValues();
});

describe('the credential a turn fetched stays usable for the whole turn', () => {
  it('puts the real value back where the agent reads it (the defect this seam exists to close)', () => {
    noteHandedCredentialValues(AGENT, [SECRET]);
    // What the platform STORED after the agent's first use, verbatim shape.
    const stored = redactHandedCredentials(AGENT, `run --key ${SECRET} --label one`);
    expect(stored).not.toContain(SECRET);
    // What the agent READS on the next iteration.
    expect(hydrateHandedCredentials(AGENT, stored)).toBe(`run --key ${SECRET} --label one`);
  });

  it('tells the same two values apart, which an opaque placeholder cannot', () => {
    noteHandedCredentialValues(AGENT, [SECRET, SECOND]);
    const stored = redactHandedCredentials(AGENT, `first=${SECRET} second=${SECOND}`);
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain(SECOND);
    expect(hydrateHandedCredentials(AGENT, stored)).toBe(`first=${SECRET} second=${SECOND}`);
  });

  it('restores through nested tool_use arguments and tool_result content alike', () => {
    noteHandedCredentialValues(AGENT, [SECRET]);
    const messages = [
      {
        role: 'assistant' as const,
        content: [
          { type: 'tool_use', id: 'x', name: 'exec', input: { argv: ['sh', 'go.sh', redactedPlaceholderFor(AGENT, SECRET)] } },
        ] as never,
      },
      {
        role: 'user' as const,
        content: [
          { type: 'tool_result', tool_use_id: 'x', content: `api_key: ${redactedPlaceholderFor(AGENT, SECRET)}` },
        ] as never,
      },
    ];
    const out = hydrateCredentialsInMessages(AGENT, messages);
    expect(JSON.stringify(out)).toContain(SECRET);
    expect(JSON.stringify(out)).not.toContain('<redacted-credential');
  });
});

describe('a dead value is never presentable as a live one', () => {
  it('renders a value this process no longer holds as self-describing (the after-a-restart case)', () => {
    noteHandedCredentialValues(AGENT, [SECRET]);
    const stored = redactHandedCredentials(AGENT, `run --key ${SECRET}`);
    // A restart: the process forgets every value it was holding.
    forgetHandedCredentialValues();
    const read = hydrateHandedCredentials(AGENT, stored);
    expect(read).not.toContain(SECRET);
    expect(read).toBe(`run --key ${CREDENTIAL_STALE_PLACEHOLDER}`);
    expect(CREDENTIAL_STALE_PLACEHOLDER).toContain('credential_get');
  });

  it('reads the untagged placeholder every earlier release wrote as stale, without rewriting one stored byte', () => {
    // A row written before this seam existed. It is never edited; it is READ as
    // what it is — a value that is gone.
    const historical = `run --key ${REDACTED_CREDENTIAL} --label one`;
    expect(hydrateHandedCredentials(AGENT, historical))
      .toBe(`run --key ${CREDENTIAL_STALE_PLACEHOLDER} --label one`);
  });
});

describe('the value reaches only the agent that fetched it', () => {
  it('refuses to restore another agent\'s value, and says why in the same breath', () => {
    noteHandedCredentialValues(AGENT, [SECRET]);
    const stored = redactHandedCredentials(AGENT, `run --key ${SECRET}`);
    const readByOther = hydrateHandedCredentials(OTHER, stored);
    expect(readByOther).not.toContain(SECRET);
    expect(readByOther).toBe(`run --key ${CREDENTIAL_STALE_PLACEHOLDER}`);
  });
});

describe('with no credential in flight the seam does nothing at all (OR7 / roadmap #10)', () => {
  it('returns the assembler\'s own array BY REFERENCE when no placeholder is present', () => {
    const messages = [
      { role: 'user' as const, content: 'what is the weather' },
      { role: 'assistant' as const, content: [{ type: 'text', text: 'checking' }] as never },
    ];
    expect(hydrateCredentialsInMessages(AGENT, messages)).toBe(messages);
  });

  it('is still by-reference for an agent that IS holding values, when the array carries none', () => {
    noteHandedCredentialValues(AGENT, [SECRET]);
    const messages = [{ role: 'user' as const, content: 'unrelated question' }];
    expect(hydrateCredentialsInMessages(AGENT, messages)).toBe(messages);
  });

  it('leaves a string with no placeholder byte-identical', () => {
    noteHandedCredentialValues(AGENT, [SECRET]);
    const text = 'nothing here to restore';
    expect(hydrateHandedCredentials(AGENT, text)).toBe(text);
  });

  it('invents nothing: a secret-shaped string nobody declared is not touched (negative control)', () => {
    // No noteHandedCredentialValues call. The seam has no value to restore and
    // must not manufacture one from a shape.
    const text = 'sk-live-4f2c9a01b7e3d85f60c1a2b3 looks like a key';
    expect(hydrateHandedCredentials(AGENT, text)).toBe(text);
    expect(hydrateCredentialsInMessages(AGENT, [{ role: 'user' as const, content: text }])[0].content).toBe(text);
  });
});

describe('the seam cannot quietly spread', () => {
  // A RECORDED measurement is not a HELD one. The two reference files that carry
  // the owner's token-cost savings are safe because the hydrator runs at the
  // loop's READ point and never inside assembly — so `memory/assembler.ts`
  // produces the same bytes whatever this module is holding, and the dev
  // assembled-context instrument (a harness capture) never sees a real value.
  // If a future change moves the call into assembly, this clause fails and says
  // so, instead of a golden moving and being re-blessed.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const srcRoot = path.resolve(here, '../..');

  function filesUnder(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '__tests__') continue;
        filesUnder(p, out);
      } else if (e.name.endsWith('.ts')) out.push(p);
    }
    return out;
  }

  it('has exactly ONE production call site, and it is the tool loop', () => {
    const callers = filesUnder(srcRoot)
      .filter((f) => /\bhydrateCredentialsInMessages\s*\(/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(srcRoot, f))
      .filter((f) => f !== 'credentials/secret-values.ts')
      .sort();
    expect(callers).toEqual(['agent/v2/loop.ts']);
  });

  it('is absent from the assembler, so assembly is byte-identical whatever is held', () => {
    const assembler = fs.readFileSync(path.join(srcRoot, 'memory/assembler.ts'), 'utf8');
    expect(assembler).not.toContain('hydrate');
  });
});
