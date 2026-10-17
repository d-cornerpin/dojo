// ════════════════════════════════════════════════════════════════════════════════════════
// `deploy/install.sh`'s door to the ONE installer (t197, v3.4 F2).
//
//   node <package>/platform/packages/server/dist/update/install-tree-cli.js <package>/platform
//
// The installer script used to `rsync --delete` the package over `~/.dojo/platform` and run
// `npm ci` in the live tree: the same in-place shape the in-app update had, in a third copy.
// It now stages the package beside the live tree and switches it in with the same two renames,
// so a cut-off reinstall leaves Dojo wholly old or wholly new, exactly like an update.
//
// Runs from the UNPACKED package, which has no node_modules: its imports are Node built-ins
// and this package's own files only (see the header of `install-tree.ts`).
// ════════════════════════════════════════════════════════════════════════════════════════
import path from 'node:path';
import { homeDir } from '../home.js';
import { installPlatformTree, runNpmInstall, treeVersion, stagePackageCopy, discardWorkDir } from './install-tree.js';

const source = process.argv[2];
const dojoDir = path.join(homeDir(), '.dojo');
const target = source ? treeVersion(source) : null;
if (!source || !target) {
  console.error(`❌ ${source ?? '(no path given)'} is not a platform tree (no readable package.json version).`);
  process.exit(1);
}

let work: string | null = null;
let code = 1;
try {
  const staged = stagePackageCopy(source, dojoDir);
  work = staged.work;
  const live = treeVersion(path.join(dojoDir, 'platform'));
  console.log(`   Preparing ${target} beside the installed ${live ?? 'platform (none yet)'}...`);
  const r = await installPlatformTree({
    dojoDir, stagedDir: staged.staged, targetVersion: target, previousVersion: live, runInstall: (cwd) => runNpmInstall(cwd),
  });
  if (r.ok) {
    console.log(`✅ Platform ${target} installed${r.backupDir ? ` (the previous version is kept at ${path.basename(r.backupDir)})` : ''}.`);
    code = 0;
  } else {
    console.error(`❌ ${r.message}`);
  }
} catch (err) {
  console.error(`❌ The platform could not be prepared: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (work) discardWorkDir(work);
}
process.exit(code);
