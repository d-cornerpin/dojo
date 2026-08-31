// ════════════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR / T66b — A PROVIDER'S NAME IS DISPLAY-ONLY. The census that lets a rename be safe.
//
// The edit door (`PATCH /config/providers/:id`) lets the owner rename a provider. That is only
// a safe thing to offer if the name is not load-bearing anywhere — if some lookup keys off it,
// a rename is a silent breakage of whatever that lookup fed, and the user who typed a nicer
// name would have no way to connect the two.
//
// So the invariant is stated and machine-checked rather than asserted from memory: the ID is
// the key. `models.provider_id`, `~/.dojo/secrets.yaml` (`providers.<id>`), the client caches,
// the capability contract, the router, the budget rollup and the health surface all resolve a
// provider by its id. The behavioural half of this proof — models, credentials and agent
// assignments surviving a rename untouched — is in
// `gateway/routes/__tests__/a-provider-can-be-edited.test.ts`; this file is the STATIC half,
// so a future name-keyed lookup fails the build the day it is written rather than the day a
// user renames something.
//
// ── THE ONE ALLOWED EXCEPTION, and why it is not a defect ──
// The box-to-box migration checklist keys on the name: `migration/manifest.ts` exports the
// provider NAMES off the old box, and `migration/checks.ts` looks each one up on the new box
// (`SELECT id FROM providers WHERE name = ?`) to report whether its key came across. That is a
// checklist ITEM, not a call path: a miss renders "<name> API key needs re-entry" with a link
// to the settings page, and every model call on the box keeps working. It is also inherent to
// what a manifest is — a snapshot of another machine, taken before the rename existed to be
// applied. `migration/dependency-script.ts` reads `lower(name) LIKE '%ollama%'` in the same
// spirit, and only as the OR-arm of a `type = 'ollama'` test that already answers correctly.
//
// The allow-list below is those two files by name. Anything else that looks a provider up by
// name is a new coupling, and this test says so.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..');

/** The box-migration checklist, argued in the header: a checklist item, never a call path. */
const ALLOWED = new Set([
  'migration/checks.ts',
  'migration/dependency-script.ts',
]);

/** `... FROM providers ... WHERE [lower(]name` — a provider resolved by what it is called. */
const NAME_KEYED = /FROM\s+providers\b[^;'"`]*?\bWHERE\b[^;'"`]*?\b(?:lower\(\s*)?name\b/is;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      sourceFiles(p, out);
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

describe('T66b — the id is the key, so a rename is display-only', () => {
  it('no provider lookup outside the box-migration checklist keys on the name', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file).split('\\').join('/');
      if (ALLOWED.has(rel)) continue;
      const text = readFileSync(file, 'utf-8');
      for (const [i, line] of text.split('\n').entries()) {
        if (NAME_KEYED.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('CONTROL: the census can see a name-keyed lookup when there is one', () => {
    // The allow-listed site itself, read directly. Without this the case above passes just as
    // well when the pattern has rotted into matching nothing at all.
    const checks = readFileSync(join(SRC, 'migration/checks.ts'), 'utf-8');
    expect(checks.split('\n').some(l => NAME_KEYED.test(l))).toBe(true);
  });
});
