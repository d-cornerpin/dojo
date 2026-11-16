// Holds the Mac awake while on power (`-s`) for exactly as long as this server process lives (`-w`).
import fs from 'node:fs';
import { spawn } from 'node:child_process';

export function keepMacAwake(run: typeof spawn = spawn, bin = '/usr/bin/caffeinate'): void {
  if (!fs.existsSync(bin)) return;
  // A failed start arrives as an 'error' event, never a throw: a Mac that cannot be kept awake still runs the Dojo.
  run(bin, ['-s', '-w', String(process.pid)], { stdio: 'ignore' }).on('error', () => undefined).unref();
}
