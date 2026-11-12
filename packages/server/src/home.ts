// The one place that decides where "home" is: `DOJO_HOME` (absolute) when set, else `os.homedir()`.
// Tests set it per worker (packages/server/vitest.setup.ts) so they never touch the real home.

import os from 'node:os';
import path from 'node:path';

/** The home directory every `~/.dojo` path in the server hangs off. Not cached: tests rebind it per case. */
export function homeDir(): string {
  const override = process.env.DOJO_HOME;
  if (override !== undefined && override !== '') {
    if (!path.isAbsolute(override)) {
      throw new Error(
        `DOJO_HOME must be an absolute path; got ${JSON.stringify(override)}. ` +
          'A relative home resolves differently in every process that reads it.',
      );
    }
    return override;
  }

  return os.homedir();
}

export function dojoDir(...segments: string[]): string {
  return path.join(homeDir(), '.dojo', ...segments);
}
