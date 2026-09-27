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
import fs from 'node:fs';
import path from 'node:path';
import {
  fullDiskAccessInstructions, fullDiskAccessWhy,
  FULL_DISK_ACCESS_PANE, FULL_DISK_ACCESS_VERIFY,
} from '@dojo/shared';

const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
const SETTINGS = path.join(REPO_ROOT, 'packages/dashboard/src/pages/Settings.tsx');
const SETUP_DEPS = path.join(REPO_ROOT, 'packages/dashboard/src/components/SetupDeps.tsx');
const INSTALL_SH = path.join(REPO_ROOT, 'deploy/install.sh');
const read = (p: string): string => fs.readFileSync(p, 'utf-8');

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

describe('ONE source — neither surface writes its own copy', () => {
  it('⚠ both surfaces import the shared helper', () => {
    for (const p of [SETTINGS, SETUP_DEPS]) {
      expect(read(p), `${path.basename(p)} must use the shared copy`)
        .toMatch(/fullDiskAccessInstructions/);
    }
  });

  it('⚠ neither surface still tells the user to grant Terminal', () => {
    // The census that would have caught this in the first place. Scoped to the two files the
    // audit named; a third surface would be caught by the shared-helper clause above.
    for (const p of [SETTINGS, SETUP_DEPS]) {
      const offenders = read(p).split('\n')
        .filter(l => /Full Disk Access/i.test(l) && /Terminal/i.test(l));
      expect(offenders, `${path.basename(p)} still names Terminal`).toEqual([]);
    }
  });

  it('⚠ neither surface hand-writes the FULL DISK ACCESS pane path of its own', () => {
    // Scoped to Full Disk Access on purpose. Both files legitimately spell OTHER Privacy panes
    // (Accessibility for `cliclick`, Automation), which are different permissions with their own
    // correct targets and are not this item's subject — the Automation hint's "node" is the same
    // CLASS of vagueness and is reported rather than silently widened into here.
    for (const p of [SETTINGS, SETUP_DEPS]) {
      const hand = read(p).split('\n')
        .filter(l => /Full Disk Access/i.test(l) && /Privacy\s*(&amp;|&)\s*Security/i.test(l));
      expect(hand, `${path.basename(p)} spells the FDA pane itself instead of importing it`).toEqual([]);
    }
  });
});

describe('the premise is still true of the installer', () => {
  it('⚠ install.sh really does launch node by resolved path under launchd', () => {
    // If the installer ever stops doing this, the copy above becomes wrong and this clause is
    // where that shows up — the instruction is only correct because of these two lines.
    const sh = read(INSTALL_SH);
    expect(sh).toMatch(/NODE_PATH=\$\(which node\)/);
    expect(sh).toMatch(/<string>\$\{NODE_PATH\}<\/string>/);
    expect(sh).toMatch(/packages\/server\/dist\/index\.js/);
  });
});

describe('the server reports the path the copy needs', () => {
  it('⚠ the permissions endpoint returns serverExecPath from process.execPath', () => {
    const route = read(path.join(REPO_ROOT, 'packages/server/src/gateway/routes/setup-deps.ts'));
    expect(route).toMatch(/serverExecPath:\s*process\.execPath/);
    // …and the grant is genuinely probed by the read it protects, which is why the copy is
    // allowed to promise proof.
    expect(route).toMatch(/Library['"`]?,\s*['"`]Messages['"`],\s*['"`]chat\.db['"`]/);
    expect(route).toMatch(/accessSync\(chatDb, fs\.constants\.R_OK\)/);
  });
});
