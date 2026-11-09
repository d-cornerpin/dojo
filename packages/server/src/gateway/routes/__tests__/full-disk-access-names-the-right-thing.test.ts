// ════════════════════════════════════════════════════════════════════════════════════════
// THE FULL-DISK-ACCESS COPY NAMES THE EXECUTABLE THAT DOES THE READING (audit finding 5).
//
// ── WHAT SHIPPED: three instructions, two surfaces, none of them right ──
//   Settings.tsx:419   "Requires Full Disk Access for Terminal"
//   Settings.tsx:663   "ensure Terminal has Full Disk Access … > Enable Terminal"
//   SetupDeps.tsx:588  'macOS … add "node" … look for "node" in the list and toggle it ON'
//
// ── MEASURED, which is what settles it ──
// `deploy/install.sh:231` resolves `NODE_PATH=$(which node)` and writes a LaunchAgent whose
// `ProgramArguments` are `[<that node>, <platform>/packages/server/dist/index.js]`. So a packaged
// install runs under launchd as **the node binary at one absolute path**. Terminal is not in the
// picture at all, and "node" alone is not findable — the FDA list shows names, a box can have
// several nodes, and on the audited machine the real one lives under
// `~/.nvm/versions/node/<ver>/bin`, which no user will guess.
//
// Only the running server knows that path (`process.execPath`), so it reports it as
// `serverExecPath` and both surfaces render it through ONE shared function.
//
// ── THE VERIFY AFFORDANCE IS REAL, so there is no "we cannot check this" line ──
// `checkPermission('full-disk-access')` attempts `fs.accessSync(~/Library/Messages/chat.db, R_OK)`
// — the very read the permission protects — so a pass is proof. The one thing it cannot see is
// stated rather than hidden: macOS applies a new grant only to a freshly started process, so
// `denied` right after granting means "restart", not "failed".
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import {
  fullDiskAccessInstructions, fullDiskAccessWhy,
  FULL_DISK_ACCESS_PANE, FULL_DISK_ACCESS_VERIFY,
} from '@dojo/shared';

describe('the words name the right target', () => {
  it('⚠ with a known path, the instruction is that exact path', () => {
    const p = '/Users/someone/.nvm/versions/node/v22.22.3/bin/node';
    const s = fullDiskAccessInstructions(p);
    expect(s).toContain(p);
    expect(s).toContain(FULL_DISK_ACCESS_PANE);
    // It must actively steer the user off both wrong answers.
    expect(s).toMatch(/not to Terminal/i);
    expect(s).toMatch(/just called\s*\n?\s*"node"|entry just called "node"/i);
    // And name the restart, because the grant does not apply to a running process.
    expect(s).toMatch(/[Rr]estart/);
  });

  it('⚠ with an UNKNOWN path it says so rather than guessing one', () => {
    // A wrong path is worse than an absent one: the user would grant access to something that is
    // not doing the reading and conclude the feature is broken.
    for (const absent of [undefined, null, '', '   ']) {
      const s = fullDiskAccessInstructions(absent);
      expect(s).not.toMatch(/\/bin\/node/);
      expect(s).toMatch(/reports its exact path/i);
    }
  });

  it('the "why" line names the launchd-started binary, not Terminal', () => {
    const why = fullDiskAccessWhy();
    expect(why).toMatch(/launchd/);
    expect(why).toMatch(/not Terminal/i);
  });

  it('the verify line claims proof, and names the restart caveat', () => {
    expect(FULL_DISK_ACCESS_VERIFY).toMatch(/proof, not a\s*\n?\s*guess|proof/i);
    expect(FULL_DISK_ACCESS_VERIFY).toMatch(/restart/i);
  });
});
