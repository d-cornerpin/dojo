// Child-process driver for the t197 fault-injection suite. Run under the repo's real `tsx` with
// DOJO_HOME pointing at a scratch box, so a SIGKILL at a step boundary is a real crash of a real
// installer and not a simulated one. Not a test file.
//
//   DRIVER_MODE=install  stage SOURCE_TREE in a fresh work dir and install it; KILL_AT=<step>
//                        SIGKILLs this process the moment that step completes.
//   DRIVER_MODE=boot     what the next platform boot does first: the boot sentinel.
import fs from 'node:fs';
import path from 'node:path';

const mode = process.env.DRIVER_MODE ?? 'install';
const home = process.env.DOJO_HOME as string;
const dojoDir = path.join(home, '.dojo');

if (mode === 'boot') {
  // Exactly what index.ts does at its boot sentinel: settle, then count the boot.
  const { recordBootAttempt, readMarker } = await import('../../update-state.js');
  const { settlePendingInstall } = await import('../install-tree.js');
  settlePendingInstall(dojoDir);
  recordBootAttempt();
  process.stdout.write(`RESULT ${JSON.stringify(readMarker())}\n`);
} else {
  const { installPlatformTree, newInstallWorkDir, runNpmInstall } = await import('../install-tree.js');
  const work = newInstallWorkDir(dojoDir);
  const staged = path.join(work, 'platform');
  fs.cpSync(process.env.SOURCE_TREE as string, staged, { recursive: true });
  const env = { ...process.env, INSTALLER_PID: String(process.pid) };
  const result = await installPlatformTree({
    dojoDir,
    stagedDir: staged,
    targetVersion: process.env.TARGET_VERSION as string,
    previousVersion: process.env.PREVIOUS_VERSION ?? null,
    runInstall: (cwd: string) => runNpmInstall(cwd, env),
    onStep: (step: string) => { if (step === process.env.KILL_AT) process.kill(process.pid, 'SIGKILL'); },
  });
  process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
}
