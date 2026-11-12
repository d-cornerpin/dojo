import fs from 'node:fs';
import { spawn } from 'node:child_process';
import type { ChildRunFailure } from '../child-idle-bound.js';

// The copy stays in OUR process group (not `detached`) and is killed on `exit`, so a launchd SIGKILL of
// the group takes it down too: an orphaned `cp` would keep writing into a staging tree the next
// start's clean-up deletes. `cp` has no grandchildren; `unref()` is deliberately not called.
function copyTree(argv: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('cp', argv);
    const killChild = (): void => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
    process.once('exit', killChild);
    const settled = (fn: () => void): void => { process.off('exit', killChild); fn(); };
    let stderr = '';
    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
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
