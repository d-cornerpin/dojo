// ════════════════════════════════════════════════════════════════════════════
// `file_read: 'none'` / `file_write: 'none'` IS DENY-ALL, NOT THE LETTERS N-O-N-E.
//
// ── THE DEFECT ──
// `manifest.ts`'s `withArtifactPath` guarded exactly one scalar, `'*'`, and let
// everything else fall through to the list branch:
//
//   return value.includes(artifact) ? value : [...value, artifact];
//
// `'none'` is the OTHER live scalar on these two fields — the zod schema admits it
// deliberately (`scope.ts`'s `pathList`), the platform writes it itself
// (`tracker/pm-agent.ts`: `file_write: 'none'`), and 13 rows on the owner's own
// body carry it. On that value both operations do something quietly wrong:
// `'none'.includes(artifact)` is `String.prototype.includes` (always false here),
// and `[...'none', artifact]` ITERATES THE STRING — yielding
//
//   ["n", "o", "n", "e", "/Users/<user>/.dojo/uploads/<agentId>/**"]
//
// TypeScript could not see it: `PermissionManifest.file_read`/`file_write` were
// typed `string[] | '*'` while `file_delete` and `network_domains` both already
// included `'none'`. That divergence between the compiled type and the runtime
// schema is what let the value reach the spread, so the type was widened to match
// the schema as part of the same fix.
//
// ── WHY IT MATTERS, AND IT IS NOT COSMETIC ──
// `brokers/grants.ts`'s projection reads `Array.isArray(value)` and pushes one
// ALLOW rule per element. Four of those elements are single letters, so a deny-all
// agent was handed literal `allow` patterns `n`, `o`, `n` and `e` — and
// `brokers/fs.ts`'s `configured` flag flipped from false to true, changing the
// refusal a real agent sees from "file_write not configured for this agent" to
// "file_write not allowed for path: …". The corruption is reachable from EVERY
// read of the manifest, and `scope.ts`'s `defaultChildScope` serializes whatever
// it is handed into a spawned child's own row.
//
// ── WHAT DENY-ALL MUST STAY ──
// `'none'` comes back unchanged: the artifact directory is NOT appended to it.
// `'none'` is the one value whose entire meaning is that there is nothing to
// widen, so widening it into "may write one directory" would be this helper
// overruling a stored decision. The negative controls below prove the T5 artifact
// widening still happens for the shapes it was written for.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi } from 'vitest';
import type { PermissionManifest } from '@dojo/shared';

// `authorizeFs` consults two DB-backed collaborators AFTER the rule ladder: the
// squad-workspace fallback and the trainer-identity guard. Neither is this
// suite's subject and both would need an `agents` table, so they answer "no" —
// which is also the honest answer for an agent in no squad. Stubbed rather than
// seeded so a verdict here can only have come from the manifest.
vi.mock('../squad-workspace.js', () => ({
  hasSquadWorkspaceAccess: () => false,
}));
vi.mock('../../config/platform.js', () => ({
  isTrainerAgent: () => false,
  isPrimaryAgent: () => false,
}));
import { PRIMARY_AGENT_PERMISSIONS, artifactPathFor } from '../manifest.js';
import { defaultChildScope, resolveChildScope, parseStoredManifest } from '../scope.js';
import { projectManifestToRules, grantForManifest } from '../brokers/grants.js';
import { authorizeFs } from '../brokers/fs.js';
import { resolvePathArg } from '../brokers/resolve.js';

const AGENT = 'deny-all-agent';

/** A manifest that says deny-all on both path fields, as a live row says it. */
function denyAll(): PermissionManifest {
  return { ...PRIMARY_AGENT_PERMISSIONS, file_read: 'none', file_write: 'none' };
}

/** The real broker verdict for one path, through the real resolver. */
function verdict(manifest: PermissionManifest, kind: 'fs_read' | 'fs_write', raw: string) {
  const resolved = resolvePathArg(raw);
  if (!resolved.ok) throw new Error(`fixture did not resolve: ${raw}`);
  return authorizeFs(grantForManifest(AGENT, manifest), kind, resolved.value);
}

// ── A. THE SHAPE SURVIVES THE ARTIFACT-PATH PASS ─────────────────────────────

describe('A — `none` stays `none` through the artifact-path widening', () => {
  it('does not become a list of characters', () => {
    const scoped = defaultChildScope(denyAll(), AGENT);

    expect(scoped.file_write).toBe('none');
    expect(scoped.file_read).toBe('none');
    // Said the other way round, because "is it the string" and "is it not the
    // char array" fail for different reasons and the second is the regression.
    expect(Array.isArray(scoped.file_write)).toBe(false);
    expect(Array.isArray(scoped.file_read)).toBe(false);
    expect(scoped.file_write).not.toEqual(['n', 'o', 'n', 'e', artifactPathFor(AGENT)]);
    expect(scoped.file_read).not.toEqual(['n', 'o', 'n', 'e', artifactPathFor(AGENT)]);
  });

  it('NEGATIVE CONTROL — a list parent still gains the artifact directory (T5)', () => {
    // The guard must not have been bought by disabling the widening it guards.
    const scoped = defaultChildScope(
      { ...PRIMARY_AGENT_PERMISSIONS, file_read: ['/tmp/**'], file_write: ['/tmp/**'] },
      AGENT,
    );
    expect(scoped.file_read).toEqual(['/tmp/**', artifactPathFor(AGENT)]);
    expect(scoped.file_write).toEqual(['/tmp/**', artifactPathFor(AGENT)]);
  });

  it('NEGATIVE CONTROL — `*` is still left alone rather than enumerated', () => {
    const scoped = defaultChildScope(PRIMARY_AGENT_PERMISSIONS, AGENT);
    expect(scoped.file_read).toBe('*');
    expect(scoped.file_write).toBe('*');
  });

  it('survives the whole create/spawn path — `resolveChildScope`, as the route calls it', () => {
    // `POST /api/agents` (gateway/routes/agents.ts) and `spawner.ts` both reach
    // the spread through here, and this is the object that gets JSON-serialized
    // into the new agent's row — so a char array here is a char array ON DISK.
    const resolved = resolveChildScope(
      { file_read: 'none', file_write: 'none' },
      PRIMARY_AGENT_PERMISSIONS,
      AGENT,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.manifest.file_write).toBe('none');
    expect(resolved.manifest.file_read).toBe('none');

    // And what would land in the row round-trips as the same scalar, rather than
    // as four one-letter allow patterns.
    const stored = JSON.parse(JSON.stringify(resolved.manifest)) as PermissionManifest;
    expect(stored.file_write).toBe('none');
    const reparsed = parseStoredManifest(JSON.stringify(stored));
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) expect(reparsed.manifest.file_write).toBe('none');
  });

  it('a child of a deny-all parent cannot be widened past it', () => {
    // The subset rule still bounds the child: `pathSubset` reads `'none'` as
    // "nothing", so a parent of nothing can hand out nothing.
    const refused = resolveChildScope(
      { file_write: ['/tmp/**'] },
      denyAll(),
      'grandchild',
    );
    expect(refused.ok).toBe(false);
  });
});

// ── B. THE PROJECTION, WHICH IS WHERE THE LETTERS BECAME PERMISSIONS ─────────

describe('B — deny-all projects NO allow rule, so the letters are not grants', () => {
  it('yields no fs_write / fs_read allow rows at all', () => {
    const rules = projectManifestToRules(defaultChildScope(denyAll(), AGENT));

    const writes = rules.filter((r) => r.effectKind === 'fs_write' && r.mode === 'allow');
    const reads = rules.filter((r) => r.effectKind === 'fs_read' && r.mode === 'allow');
    expect(writes).toEqual([]);
    expect(reads).toEqual([]);

    // The specific garbage this defect minted, named so a partial fix cannot pass.
    const patterns = rules.map((r) => r.pattern);
    for (const letter of ['n', 'o', 'e']) {
      expect(patterns, `single letter ${letter} must never be a pattern`).not.toContain(letter);
    }
  });

  it('a deny-all agent is refused a write, AND told it is not configured', () => {
    // The wording is the user-visible half of the defect: with the char array
    // `authorizeFs`'s `configured` flag flipped true, so the agent was told "not
    // allowed for path", which reads as a path problem a model will try to route
    // around, instead of "not configured", which is the truth.
    const scoped = defaultChildScope(denyAll(), AGENT);

    const write = verdict(scoped, 'fs_write', '/tmp/whatever.txt');
    expect(write.allowed).toBe(false);
    expect(write.reason ?? '').toMatch(/file_write not configured for this agent/);

    const read = verdict(scoped, 'fs_read', '/tmp/whatever.txt');
    expect(read.allowed).toBe(false);
    expect(read.reason ?? '').toMatch(/file_read not configured for this agent/);
  });

  it('⚠ THE SECURITY CLAUSE — a file literally named `n` is NOT writable', () => {
    // `[...'none']` put `n`, `o` and `e` in the allow list as patterns, and
    // `matchPathPattern` is what then had to be relied on to refuse them.
    const scoped = defaultChildScope(denyAll(), AGENT);
    for (const p of ['/n', '/o', '/e', '/tmp/n']) {
      expect(verdict(scoped, 'fs_write', p).allowed, `write ${p}`).toBe(false);
      expect(verdict(scoped, 'fs_read', p).allowed, `read ${p}`).toBe(false);
    }
  });

  it('NEGATIVE CONTROL — a real allowlist still projects its own rules', () => {
    const rules = projectManifestToRules(
      defaultChildScope({ ...PRIMARY_AGENT_PERMISSIONS, file_write: ['/tmp/**'] }, AGENT),
    );
    const writes = rules
      .filter((r) => r.effectKind === 'fs_write' && r.mode === 'allow')
      .map((r) => r.pattern);
    expect(writes).toContain('/tmp/**');
    expect(writes).toContain(artifactPathFor(AGENT));
  });
});
