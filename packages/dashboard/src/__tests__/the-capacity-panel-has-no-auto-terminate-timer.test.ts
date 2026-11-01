// R25 (P13): the Dojo Capacity panel offered "Default Timeout ... before auto-terminating (900 s)". The
// server no longer has such a setting (agent/spawner.ts: "there is NO default timeout"; the creator
// owns a lifetime), so the control did nothing and promised a give-up the product does not have.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

describe('the capacity panel', () => {
  it('offers no auto-terminate timeout', () => {
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../components/settings/PlatformTab.tsx'), 'utf8');
    expect(src).not.toMatch(/spawn_default_timeout/);
    expect(src).not.toMatch(/auto-terminating/);
  });
});
