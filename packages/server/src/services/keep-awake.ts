// Holds the Mac awake while on power (`-s`) for exactly as long as this server process lives (`-w`).
import fs from 'node:fs';
import { spawn } from 'node:child_process';

export function keepMacAwake(run: typeof spawn = spawn, bin = '/usr/bin/caffeinate'): void {
  if (!fs.existsSync(bin)) return;
  try {
    run(bin, ['-s', '-w', String(process.pid)], { stdio: 'ignore' }).on('error', () => undefined).unref();
  } catch { /* most failed starts are an 'error' event, a damaged binary throws: either way the Dojo still runs */ }
}
