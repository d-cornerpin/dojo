// ════════════════════════════════════════════════════════════════════════════════════
// t114 (CENSUS U6 + ROW 34) — NO CLOCK ABANDONS A MODEL CALL IT CANNOT CANCEL.
//
// Census row 34 covers six flat `AbortSignal.timeout` utility clocks and verdicts them SPLIT.
// Three (`probe`, `share-export`, `multistep`) are CLEAN — tiny capped inputs and a real
// fallback. Three were not, and they were not for two DIFFERENT reasons, which is why this file
// fixes them two different ways:
//
//   U6 — `system-control.ts`'s `screen_screenshot` was a genuine LEAK. `callModel` was invoked
//   with NO `abortSignal` under a `Promise.race`, and a race only ABANDONS the losing promise —
//   it cannot cancel it. On expiry the provider call kept running orphaned, outside the abort
//   registry: the GPU went on grinding, the agent was told "Screen read failed", and the
//   description the model eventually produced was thrown away. A local vision model on a 4K
//   screenshot legitimately takes over a minute, so this was the ordinary case.
//
//   ROW 34's two extractor arms (`web-tools.ts`, `browser.ts`) are NOT leaks and their 45-second
//   bounds are DEFENSIBLE — F3 measured a busy local extractor stalling real turns for MINUTES
//   against the provider's 5-minute default, and failing fast to a genuine raw-page fallback is
//   the point of the path. Scaling those bounds with declared patience would reinstate the exact
//   defect F3 closed, so they are KEPT. What was not defensible is that the degradation was
//   SILENT: the agent asked for a prompt to be applied, received the raw page under an unchanged
//   header, and could not tell its prompt had been dropped. The doctrine's requirement is that a
//   kill leaves an honest record, so the record now travels with the result the agent reads.
//
//   §1 the screenshot call is cancellable and no longer raced
//   §2 the extractor degradations announce themselves in the result
//   §3 A TREE CENSUS, counting in both directions: no `Promise.race` anywhere guards a
//      `callModel` that was handed no signal — which is what stops this shape being re-added
//      somewhere new.
// ════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Source with comments stripped. These files discuss the old shapes at length in prose — a
 *  clause reading raw text would be satisfied by the commentary rather than the code (G4). */
function stripped(rel: string): string {
  const raw = fs.readFileSync(path.join(SRC, rel), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

/** Every .ts under `agent/` and `services/`, which is where model calls live. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        walk(full);
      } else if (entry.name.endsWith('.ts')) {
        out.push(path.relative(SRC, full));
      }
    }
  };
  walk(path.join(SRC, 'agent'));
  walk(path.join(SRC, 'services'));
  return out;
}

describe('§1 the screen-read vision call is cancellable, not raced', () => {
  it('THE RED: the model call is handed a real abort signal', () => {
    const src = stripped('agent/system-control.ts');

    expect(
      /openAgentCall\(\s*agentId,\s*'turn',\s*AbortSignal\.timeout\(\s*SCREEN_READ_MODEL_TIMEOUT_MS\s*\)\s*\)/.test(src),
      'the bound is composed into the registered call, not raced against it',
    ).toBe(true);
    expect(
      /abortSignal:\s*slot\.signal/.test(src),
      'and the signal actually reaches callModel — without this the abort cuts nothing',
    ).toBe(true);
  });

  it('the race is GONE — there is no losing promise left to abandon', () => {
    const src = stripped('agent/system-control.ts');

    expect(
      /Promise\.race/.test(src),
      'a race here is the defect: it cannot cancel, so it orphans the call and discards its answer',
    ).toBe(false);
  });

  it('the slot is RELEASED, so a settled call is not the next stop\'s business', () => {
    const src = stripped('agent/system-control.ts');
    expect(/slot\.release\(\)/.test(src), 'the registration is handed back').toBe(true);
  });

  it('CONTROL: the honest timeout wording survives — the agent still learns what happened', () => {
    // The old message was good and the agent relies on it; the fix moved where it is produced,
    // from a racing promise to the translation of the call's own abort. Losing it would trade one
    // dishonesty for another.
    const raw = fs.readFileSync(path.join(SRC, 'agent/system-control.ts'), 'utf8');
    expect(raw).toMatch(/screen_screenshot timed out after/);
    expect(raw, 'and it still says the screenshot itself was fine').toMatch(/screenshot was captured fine/);
  });
});

describe('§2 the extractor degradations stop being silent', () => {
  it('THE RED: web_fetch tells the agent when its extraction prompt was not applied', () => {
    const src = stripped('agent/web-tools.ts');

    expect(
      /your extraction prompt was NOT applied/.test(src),
      'the note must ride the RESULT, not just the log — the agent cannot read the log',
    ).toBe(true);
    expect(
      /extractionSkipped/.test(src),
      'and it is driven by whether the extraction actually happened',
    ).toBe(true);
  });

  it('THE RED: web_browse does the same for a goal that was not applied', () => {
    const src = stripped('agent/browser.ts');

    expect(/your extraction goal was NOT applied/.test(src)).toBe(true);
    expect(/extractionSkipped/.test(src)).toBe(true);
  });

  it('an ABANDONED extractor reads differently from a FAILED one, because they are different facts', () => {
    // A timeout means the extraction may have been perfectly healthy and was dropped anyway,
    // which is what the agent needs in order to decide whether asking again is worth it.
    for (const rel of ['agent/web-tools.ts', 'agent/browser.ts']) {
      const src = stripped(rel);
      expect(/still working at its 45s bound and was abandoned/.test(src), `${rel} names the abandonment`).toBe(true);
      expect(/abort\|timed out\|timeout/.test(src), `${rel} distinguishes the two`).toBe(true);
    }
  });

  it('CONTROL: the 45s bounds are KEPT — F3\'s measured defect is not reopened', () => {
    // This is the clause that stops a future reader "finishing the job" by deleting the bounds.
    // The fallback is real and fast failure to it is the design; minutes of stall is the defect.
    for (const rel of ['agent/web-tools.ts', 'agent/browser.ts']) {
      const src = stripped(rel);
      expect(
        /abortSignal:\s*AbortSignal\.timeout\(45_000\)/.test(src),
        `${rel} keeps its deliberate best-effort bound`,
      ).toBe(true);
      expect(/bestEffort:\s*true/.test(src), `${rel} is still declared best-effort`).toBe(true);
    }
  });
});

describe('§3 the tree census — this shape cannot come back somewhere new', () => {
  it('no file races a callModel it handed no abortSignal', () => {
    // Counts in BOTH directions (G4): it is not a presence check on three known files but a sweep
    // of every source file under `agent/` and `services/`, so a NEW site with the same shape
    // fails this clause rather than slipping in beside it.
    const offenders: string[] = [];
    for (const rel of sourceFiles()) {
      const src = stripped(rel);
      if (!/Promise\.race/.test(src)) continue;
      if (!/callModel\(/.test(src)) continue;
      // A race in a file that also dials a model is only safe if that dial carries a signal.
      if (!/abortSignal:/.test(src)) offenders.push(rel);
    }

    expect(
      offenders,
      'a raced model call with no signal is orphaned on expiry and its answer is discarded',
    ).toEqual([]);
  });

  it('CONTROL: the census can actually see files — it is not vacuously green', () => {
    // A sweep that silently walked nothing would pass the clause above for the wrong reason.
    const files = sourceFiles();
    expect(files.length, 'the walk found real source files').toBeGreaterThan(50);
    expect(files, 'including the one this file exists for').toContain('agent/system-control.ts');
  });
});
