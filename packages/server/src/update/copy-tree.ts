import fs from 'node:fs';
import { spawn } from 'node:child_process';
import type { ChildRunFailure } from '../child-idle-bound.js';

// THE COPY MUST NOT OUTLIVE US. `cp -R` on a node_modules takes minutes, and a kill that
// lands inside one used to reparent the child: it kept writing into the staging tree while
// the NEXT start's clean-up deleted that same tree under it. So the copy stays in OUR process
// group (NOT `detached`): launchd ends an overrunning job with a SIGKILL to its whole group,
// and no `exit` hook runs on a SIGKILL, so group membership is what takes the copy down with
// the server. The `exit` hook covers the ordinary exit. `cp` has no grandchildren, so killing
// the child is complete. `unref()` is deliberately NOT called, and there is no timer.
function copyTree(argv: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('cp', argv);
    const killChild = (): void => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
    process.once('exit', killChild);
    const settled = (fn: () => void): void => { process.off('exit', killChild); fn(); };
    let stderr = '';
    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    // Shaped like `ChildRunFailure` (child-idle-bound.ts): `childFailureText` and
    // `isOutOfSpaceError` at the call site read `message`/`stderr`/`code` off it.
    child.once('error', (err) => settled(() => reject({
      stdout: '', stderr, code: (err as NodeJS.ErrnoException).code, message: err.message,
    } satisfies ChildRunFailure)));
    child.once('close', (code, signal) => settled(() => {
      if (code === 0) { resolve(); return; }
      reject({
        stdout: '', stderr, code: code ?? undefined, signal: signal ?? undefined,
        message: `cp ${argv.join(' ')} ${signal ? `was killed by ${signal}` : `exited with code ${code}`}${stderr ? `: ${stderr.trim()}` : ''}`,
      } satisfies ChildRunFailure);
    }));
  });
}

/** Copy-on-write clone on APFS (free); a plain copy where the volume cannot clone. */
export async function cloneTree(src: string, dst: string): Promise<void> {
  try { await copyTree(['-Rc', src, dst]); } catch {
    fs.rmSync(dst, { recursive: true, force: true });
    await copyTree(['-R', src, dst]);
  }
}
