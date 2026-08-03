// ════════════════════════════════════════════════════════════════════════════
// THE FACADE'S CONTRACT (PHASE-5 T8 Steps 1, 2 and 3 — the PERMANENT form).
//
// T8 Step 1 proved the residual RED with a temporary test: **a handler could act
// on a resource the gate loop never authorized, and nothing noticed.** The plan
// requires that proof to become durable and to flip green *because the reach
// became impossible, never because the test changed*. This file is that
// artifact, and every clause below is written so it fails if the facade is
// removed, bypassed, or allowed to grow a permission of its own.
//
// The four things it holds:
//   1. THE REACH IS REFUSED. A converted call site reaching a resource the call
//      never declared is refused, and so is one reaching with no authorization
//      at all.
//   2. THE CAPABILITY IS UNFORGEABLE, structurally. No facade entry takes one as
//      a parameter, and the mint has exactly ONE production caller — the
//      executor's gate loop — read out of the source tree.
//   3. THE FACADE MAKES NO JUDGEMENT OF ITS OWN (the task's STOP condition 2, as
//      a check rather than a promise): the carrying modules hold none of the
//      deciding vocabulary.
//   4. THE CONVERTED CATEGORY IS CONVERTED: the process door no longer imports
//      `child_process` at all, which is what makes the lint flip honest for it.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  mintCallCapability, attachCallCapability, currentCapability,
  grantsCover, EffectNotAuthorized, type ResourceGrant,
} from '../capability.js';
import { runWithToolCallId } from '../../turn-state.js';
import { grantsForCall, expandScopeTemplate, CARRIED_PROGRAMS, INDIRECT_RESOLVERS } from '../scopes.js';
import { effectsFor } from '../../tools/registry.js';
import { execFileAuthorized } from '../proc.js';
import * as effectFs from '../fs.js';
import { runProcess } from '../../tools/process-run.js';
import type { ToolEffect } from '../../tools/types.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const AGENT = 'agent-under-test';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-contract-'));
const inScope = path.join(scratch, 'declared.txt');
const outOfScope = path.join(scratch, 'never-declared.txt');
fs.writeFileSync(inScope, 'the resource this call declared\n');
fs.writeFileSync(outOfScope, 'a resource it did not\n');

/**
 * Drive the REAL per-call context, because that is what the capability's
 * liveness is derived from: `runWithToolCallId` is the same door the executor
 * opens once per tool call, and a capability outside one is dead by
 * construction rather than by a flag this test would have to remember to clear.
 */
function inCall<T>(grants: ResourceGrant[], tool: string, body: () => T | Promise<T>): Promise<T> {
  return runWithToolCallId(AGENT, 'call-1', async () => {
    attachCallCapability(mintCallCapability({ agentId: AGENT, tool, callId: 'call-1', grants }));
    return body();
  });
}

const pathGrant = (kind: 'fs_read' | 'fs_write' | 'fs_delete', p: string): ResourceGrant =>
  ({ kind, at: 'path', lexical: p, real: p });

// ════════════════════════════════════════════════════════════════════════════
// 1 — THE REACH IS REFUSED (Step 1's residual, permanently)
// ════════════════════════════════════════════════════════════════════════════

describe('a converted call site cannot act on a resource the call never declared', () => {
  it('the process door RUNS the program its call declared', async () => {
    const audited: string[] = [];
    const out = await inCall([{ kind: 'proc', program: 'echo', display: 'echo hi' }], 'exec', () =>
      runProcess({
        auditTarget: 'echo hi', file: 'echo', argv: ['hi'],
        timeout: 5000, cwd: undefined, note: null,
        audit: (target, result) => { audited.push(`${target}:${result}`); },
      }));
    expect(out).toContain('hi');
    expect(audited).toEqual(['echo hi:success']);
  });

  it('THE RESIDUAL, CLOSED: the same door reaching a DIFFERENT program is refused', async () => {
    // This is the T8 Step 1 proof in its permanent shape. Before the facade the
    // handler held `child_process` and could spawn anything; the gate loop's
    // decision was about `echo` and nothing carried it any further.
    await inCall([{ kind: 'proc', program: 'echo', display: 'echo hi' }], 'exec', async () => {
      await expect(execFileAuthorized('/bin/sh', ['-c', 'echo reached'], {
        timeout: 5000, maxBuffer: 1024, encoding: 'utf-8',
      })).rejects.toBeInstanceOf(EffectNotAuthorized);
    });
  });

  it('and with NO authorization at all it is refused too — that is the strongest form', async () => {
    await expect(execFileAuthorized('echo', ['hi'], {
      timeout: 5000, maxBuffer: 1024, encoding: 'utf-8',
    })).rejects.toBeInstanceOf(EffectNotAuthorized);
    expect(() => effectFs.readFileSync(inScope, 'utf8')).toThrow(EffectNotAuthorized);
  });

  it('the fs entries read what the call declared and refuse what it did not', async () => {
    await inCall([pathGrant('fs_read', inScope)], 'file_read', () => {
      expect(effectFs.readFileSync(inScope, 'utf8')).toContain('the resource this call declared');
      expect(() => effectFs.readFileSync(outOfScope, 'utf8')).toThrow(EffectNotAuthorized);
      // A read grant is not a write grant.
      expect(() => effectFs.writeFileSync(inScope, 'x')).toThrow(EffectNotAuthorized);
    });
  });

  it('a capability answers NOTHING from outside its call — invoked later, from another context', async () => {
    // The leak this closes: a closure minted inside a dispatch and CALLED from
    // somewhere else — a poller, a route, a watcher started at boot. It holds a
    // reference, and without an expiry it would hold a live authorization.
    let escaped: (() => void) | null = null;
    await inCall([pathGrant('fs_read', inScope)], 'file_read', () => {
      expect(currentCapability()).not.toBeNull();
      escaped = (): void => { effectFs.readFileSync(inScope, 'utf8'); };
    });
    expect(escaped).not.toBeNull();
    expect(escaped!).toThrow(EffectNotAuthorized);
  });

  it('…but work STARTED INSIDE the call keeps it while it runs, and that is the correct answer', async () => {
    // MEASURED, T8D — an earlier wording of `capability.ts`'s header said a
    // fire-and-forget continuation outliving its dispatch holds a DEAD
    // capability. It does not: the continuation inherits the call's async
    // context. This clause pins the real contract because it decides which
    // remaining modules can convert at all.
    //
    // It is the RIGHT answer rather than a hole: the continuation is still THAT
    // call's own work, and it can still only touch what THAT call declared —
    // proven by the second half. `image_create` answers the model at once and
    // delivers the image from exactly this shape.
    let insideLater: unknown = null;
    let refusedLater: unknown = null;
    let finish!: () => void;
    const ran = new Promise<void>((r) => { finish = r; });

    await inCall([pathGrant('fs_read', inScope)], 'image_create', () => {
      void (async () => {
        await new Promise((r) => setTimeout(r, 5));
        try { insideLater = effectFs.readFileSync(inScope, 'utf8'); } catch (err) { insideLater = err; }
        try { effectFs.readFileSync(outOfScope, 'utf8'); } catch (err) { refusedLater = err; }
        finish();
      })();
    });
    await ran;
    expect(typeof insideLater, 'the declared resource is still reachable from the continuation').toBe('string');
    expect(refusedLater, 'and the undeclared one is still refused there').toBeInstanceOf(EffectNotAuthorized);
  });

  it('the refusal says which tool reached where, so a too-narrow declaration is adjudicable', async () => {
    await inCall([pathGrant('fs_read', inScope)], 'file_read', () => {
    try {
      effectFs.readFileSync(outOfScope, 'utf8');
      expect.unreachable('the facade must refuse');
    } catch (err) {
      expect(err).toBeInstanceOf(EffectNotAuthorized);
      const refusal = err as EffectNotAuthorized;
      expect(refusal.tool).toBe('file_read');
      expect(refusal.message).toContain(outOfScope);
      expect(refusal.message).toContain('beyond the resources this call declared');
    }
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2 — THE MATCH: set membership over resolved resources, nothing more
// ════════════════════════════════════════════════════════════════════════════

describe('the match is declaration-match, and it matches what a declaration means', () => {
  it('an exact path grant covers that path in either spelling', () => {
    const g: ResourceGrant[] = [{ kind: 'fs_read', at: 'path', lexical: '/a/link.txt', real: '/a/real.txt' }];
    expect(grantsCover(g, { op: 'fs_read', path: '/a/link.txt', real: '/a/real.txt' })).toBe(true);
    expect(grantsCover(g, { op: 'fs_read', path: '/a/other.txt', real: '/a/other.txt' })).toBe(false);
  });

  it('a tree grant covers what is inside it and NOT its neighbours', () => {
    const g: ResourceGrant[] = [{ kind: 'fs_write', at: 'tree', root: '/u/uploads/a1' }];
    expect(grantsCover(g, { op: 'fs_write', path: '/u/uploads/a1/x.png', real: '/u/uploads/a1/x.png' })).toBe(true);
    expect(grantsCover(g, { op: 'fs_write', path: '/u/uploads/a1', real: '/u/uploads/a1' })).toBe(true);
    // The prefix trap: a sibling directory whose name starts with the same text.
    expect(grantsCover(g, { op: 'fs_write', path: '/u/uploads/a12/x.png', real: '/u/uploads/a12/x.png' })).toBe(false);
    expect(grantsCover(g, { op: 'fs_write', path: '/u/uploads/a2/x.png', real: '/u/uploads/a2/x.png' })).toBe(false);
  });

  it('a metadata probe is covered by ANY grant naming the path — a write may ask if it exists', () => {
    const write: ResourceGrant[] = [pathGrant('fs_write', '/a/f.txt')];
    expect(grantsCover(write, { op: 'fs_stat', path: '/a/f.txt', real: '/a/f.txt' })).toBe(true);
    // …but it is still not a read of the bytes.
    expect(grantsCover(write, { op: 'fs_read', path: '/a/f.txt', real: '/a/f.txt' })).toBe(false);
  });

  it('mkdir is covered by a write grant on something inside the directory, not by anything else', () => {
    const write: ResourceGrant[] = [pathGrant('fs_write', '/a/b/c/f.txt')];
    expect(grantsCover(write, { op: 'fs_mkdir', path: '/a/b/c', real: '/a/b/c' })).toBe(true);
    expect(grantsCover(write, { op: 'fs_mkdir', path: '/a/b', real: '/a/b' })).toBe(true);
    expect(grantsCover(write, { op: 'fs_mkdir', path: '/elsewhere', real: '/elsewhere' })).toBe(false);
    const read: ResourceGrant[] = [pathGrant('fs_read', '/a/b/c/f.txt')];
    expect(grantsCover(read, { op: 'fs_mkdir', path: '/a/b/c', real: '/a/b/c' })).toBe(false);
  });

  it('a program grant covers that program and no other', () => {
    const g: ResourceGrant[] = [{ kind: 'proc', program: 'git', display: 'git status' }];
    expect(grantsCover(g, { op: 'proc', program: 'git' })).toBe(true);
    expect(grantsCover(g, { op: 'proc', program: '/bin/sh' })).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3 — DECLARATION → RESOURCE: what the gate loop mints, and what it refuses to
// ════════════════════════════════════════════════════════════════════════════

describe('grantsForCall reads the registry, and invents nothing', () => {
  const effect = (kind: ToolEffect['kind'], from: string, scope?: ToolEffect['scope']): ToolEffect =>
    (scope ? { kind, from, scope } : { kind, from });

  it('an args. effect resolves to the path the agent named', () => {
    const grants = grantsForCall(AGENT, [effect('fs_read', 'args.path')], { path: inScope });
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ kind: 'fs_read', at: 'path' });
  });

  it('an args. effect whose argument is absent yields NO grant — it does not widen', () => {
    expect(grantsForCall(AGENT, [effect('fs_read', 'args.path')], {})).toEqual([]);
  });

  it('an args.<name>[] effect mints ONE grant PER ELEMENT — the declaration says "every one of them"', () => {
    // THE GAP THIS CLOSES (T8C §5a, re-derived: 11 fs-kind declarations write
    // this shape): the resolver read `args.attachments[]` as a literal key,
    // found no argument called `attachments[]`, and yielded NO grant at all. A
    // declaration that resolves to nothing is fail-closed in the WRONG place —
    // it reads as "this tool touches no file" when the tool touches every file
    // in the list, and the first converted site would refuse working behaviour.
    const a = path.join(scratch, 'a.pdf');
    const b = path.join(scratch, 'b.pdf');
    const grants = grantsForCall(AGENT, [effect('fs_read', 'args.attachments[]')], { attachments: [a, b] });
    expect(grants).toHaveLength(2);
    expect(grantsCover(grants, { op: 'fs_read', path: a, real: a })).toBe(true);
    expect(grantsCover(grants, { op: 'fs_read', path: b, real: b })).toBe(true);
    // …and nothing the call did not list.
    expect(grantsCover(grants, { op: 'fs_read', path: outOfScope, real: outOfScope })).toBe(false);
  });

  it('…and an absent, empty, non-array or non-string element yields nothing rather than widening', () => {
    const e = (args: Record<string, unknown>): unknown[] =>
      grantsForCall(AGENT, [effect('fs_read', 'args.attachments[]')], args);
    expect(e({}), 'absent').toEqual([]);
    expect(e({ attachments: [] }), 'empty list').toEqual([]);
    expect(e({ attachments: inScope }), 'a bare string is not the declared list').toEqual([]);
    expect(e({ attachments: [42, null] }), 'non-string elements').toEqual([]);
    // One good element among bad ones grants that one and no more.
    expect(e({ attachments: [inScope, 42] })).toHaveLength(1);
  });

  it('a derived effect with NO declared scope yields no grant — the honest fail-closed', () => {
    // This is RULING P5-R14 branch (A) stated as behaviour: prose is not a
    // scope. An unconverted handler is unaffected (it still calls node:fs); a
    // converted one refuses loudly, which is the signal the declaration is owed.
    expect(grantsForCall(AGENT, [effect('fs_write', 'derived:the uploads directory')], {})).toEqual([]);
  });

  it('a derived effect WITH a declared scope resolves to that tree', () => {
    const grants = grantsForCall(
      AGENT,
      [effect('fs_write', 'derived:the calling agent uploads directory', { at: 'tree', template: '~/.dojo/uploads/<agentId>' })],
      {},
    );
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ kind: 'fs_write', at: 'tree' });
    expect((grants[0] as { root: string }).root).toBe(path.join(os.homedir(), '.dojo', 'uploads', AGENT));
  });

  it('a scope template hole cannot climb out of the scope it is placed in', () => {
    const t = (v: unknown): string | null =>
      expandScopeTemplate('~/.dojo/techniques/{args.name}', AGENT, { name: v });
    expect(t('reports')).toBe(path.join(os.homedir(), '.dojo', 'techniques', 'reports'));
    expect(t('../../.ssh')).toBeNull();
    expect(t('a/b')).toBeNull();
    expect(t(undefined)).toBeNull();
    expect(t(42)).toBeNull();
  });

  it('the exec doors mint the program the broker just authorized', () => {
    const argv = grantsForCall(AGENT, [effect('proc', 'args.argv')], { argv: ['git', 'status'] });
    expect(argv).toEqual([{ kind: 'proc', program: 'git', display: 'git status' }]);
    const script = grantsForCall(AGENT, [effect('shell', 'args.script')], { script: 'ls | wc -l' });
    expect(script).toEqual([{ kind: 'shell', program: '/bin/zsh', display: 'ls | wc -l' }]);
  });

  it('RULING P5-R14 branch (B) is a NAMED LIST with a reason per entry, never a heuristic', () => {
    for (const [program, reason] of Object.entries(CARRIED_PROGRAMS)) {
      expect(program.length, 'a carried program needs a name').toBeGreaterThan(0);
      expect(reason.length, `${program} is carried with no reason`).toBeGreaterThan(20);
    }
    // A `derived:` program scope that is NOT on the list yields no grant, so the
    // set cannot grow by declaration alone.
    const rogue = grantsForCall(AGENT, [effect('proc', 'derived:whatever', { at: 'program', program: 'curl' })], {});
    expect(rogue).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4 — THE STRUCTURE: unforgeable, judgement-free, and actually converted
// ════════════════════════════════════════════════════════════════════════════

function productionSources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) productionSources(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

function filesContaining(token: string, within = SRC): string[] {
  return productionSources(within)
    .filter((f) => fs.readFileSync(f, 'utf8').includes(token))
    .map((f) => path.relative(SRC, f))
    .sort();
}

describe('the capability cannot be forged, and the facade holds no judgement', () => {
  it('the MINT has exactly one production caller, and IT has exactly one caller: the gate loop', () => {
    // Two levels, both enumerated, because the mint moved out of the executor
    // when the size ratchet said "move the new code elsewhere": `scopes.ts`
    // holds the only mint, and the executor holds the only call to `scopes.ts`.
    // A new caller at EITHER level is a second permission system and fails here.
    const notTheModule = (f: string): boolean => f !== 'agent/effects/capability.ts';
    expect(
      filesContaining('mintCallCapability(').filter(notTheModule),
      'a second minting site is a second permission system — read it and hand up',
    ).toEqual(['agent/effects/scopes.ts']);
    expect(
      filesContaining('attachCallCapability(').filter(notTheModule),
      'a second attach site would let a capability be planted outside the gate loop',
    ).toEqual(['agent/effects/scopes.ts']);
    expect(
      filesContaining('openCallCapability(').filter((f) => f !== 'agent/effects/scopes.ts'),
      'the capability is opened at the executor gate loop and nowhere else',
    ).toEqual(['agent/tools/index.ts']);
    // `grantsForCall` takes an OVERRIDABLE resolver table (mechanic 5, so the
    // indirection is drivable by a test without a database). Nothing in
    // production may pass its own — a caller that did would decide what an
    // argument resolves to, which is the interpretation this module owns.
    expect(
      filesContaining('grantsForCall(').filter((f) => f !== 'agent/effects/scopes.ts'),
      'grantsForCall has one production caller: the mint, in this module',
    ).toEqual([]);
  });

  it('the indirection table is a NAMED list, and a declaration cannot add to it', () => {
    // Mechanic 5's equivalent of `CARRIED_PROGRAMS`'s census: a new way to turn
    // an argument into a resource has to be written into the table by hand to
    // exist at all, so the set cannot grow by declaration.
    expect(Object.keys(INDIRECT_RESOLVERS)).toEqual(['attachment_row']);
    for (const resolve of Object.values(INDIRECT_RESOLVERS)) {
      expect(typeof resolve, 'every indirection resolves through a real reader').toBe('function');
    }
    // A `via` an effect declares that the table does not hold cannot resolve:
    // the type refuses it at compile time, and at runtime it grants nothing.
    const rogue = grantsForCall(
      AGENT,
      [{ kind: 'fs_read', from: 'args.id', via: 'not_a_real_indirection' } as unknown as ToolEffect],
      { id: 'x' },
      INDIRECT_RESOLVERS,
    );
    expect(rogue).toEqual([]);
  });

  it('NO facade entry takes a capability as a parameter — a handler has nothing to hand it', () => {
    // This is what makes unforgeability structural rather than a convention:
    // the carrying modules never name the type at all, so there is no argument
    // to forge, replay or borrow from another call.
    for (const file of ['agent/effects/fs.ts', 'agent/effects/proc.ts']) {
      const src = fs.readFileSync(path.join(SRC, file), 'utf8');
      expect(src.includes('CallCapability'), `${file} must not take a capability`).toBe(false);
      expect(src.includes('requireAuthorized'), `${file} must ask for authorization`).toBe(true);
    }
  });

  it('STOP CONDITION 2 AS A CHECK: the carrying modules hold none of the deciding vocabulary', () => {
    // The brokers DECIDE; the facade CARRIES. If a future edit needs a rule
    // here, this clause fails and the work hands up rather than growing a
    // second permission system inside the first one's shadow.
    const DECIDING = [
      'checkPermission', 'grantFor(', 'authorizeFs', 'authorizeProc', 'authorizeArgv',
      'isSensitivePath', 'DENY_RULES', 'evaluateRules', 'manifest',
    ];
    for (const file of ['agent/effects/fs.ts', 'agent/effects/proc.ts', 'agent/effects/capability.ts']) {
      const src = fs.readFileSync(path.join(SRC, file), 'utf8');
      for (const token of DECIDING) {
        expect(src.includes(token), `${file} must not ${token} — the brokers decide`).toBe(false);
      }
    }
  });

  it('CATEGORY CONVERTED: the process door no longer imports child_process', () => {
    const doorSrc = fs.readFileSync(path.join(SRC, 'agent/tools/process-run.ts'), 'utf8');
    expect(/^import .*child_process/m.test(doorSrc)).toBe(false);
    expect(doorSrc.includes('execFileAuthorized('), 'it spawns through the facade').toBe(true);
    // …and the whole toolbox tree is clean of it, which is the per-category
    // grep-zero the lint flip will rest on.
    const inToolbox = filesContaining("from 'node:child_process'", path.join(SRC, 'agent', 'tools'));
    expect(inToolbox, 'agent/tools/** must reach processes only through the facade').toEqual([]);
    // The facade itself is the one place that holds it.
    expect(filesContaining("from 'node:child_process'", path.join(SRC, 'agent', 'effects')))
      .toEqual(['agent/effects/proc.ts']);
  });

  it('CATEGORY CONVERTED: the canvas door writes its screenshot through the facade', () => {
    const doorSrc = fs.readFileSync(path.join(SRC, 'agent/tools/cat/canvas.ts'), 'utf8');
    expect(/^import .*['"]node:fs['"]/m.test(doorSrc), 'the canvas door must not hold node:fs').toBe(false);
    expect(doorSrc.includes('effectFs.'), 'it writes through the facade').toBe(true);
  });

  it('CATEGORY CONVERTED: the image generator writes its output through the facade', () => {
    const src = fs.readFileSync(path.join(SRC, 'services/image-generation.ts'), 'utf8');
    expect(/^import .*['"]node:fs['"]/m.test(src), 'the image generator must not hold node:fs').toBe(false);
    expect(src.includes('effectFs.'), 'it writes through the facade').toBe(true);
  });

  it('image_create DECLARES the generated-images directory it writes, and the scope is that alone', () => {
    // `~/.dojo/uploads/generated` is a SIBLING of the calling agent's uploads
    // directory, not inside it, so the declaration the tool already carried
    // (`derived:the calling agent uploads directory`) never covered the
    // generator's own write. Corrected at the site with its reason (P5-R14).
    const grants = grantsForCall(AGENT, effectsFor('image_create'), { prompt: 'a cat' });
    const generated = path.join(os.homedir(), '.dojo', 'uploads', 'generated');
    const png = path.join(generated, 'x.png');
    expect(grantsCover(grants, { op: 'fs_mkdir', path: generated, real: generated }), 'it may create its own directory').toBe(true);
    expect(grantsCover(grants, { op: 'fs_write', path: png, real: png }), 'it may write the generated image').toBe(true);
    // …and not a neighbour under the same parent, which is what makes it a scope.
    const neighbour = path.join(os.homedir(), '.dojo', 'uploads', 'someone-else', 'x.png');
    expect(grantsCover(grants, { op: 'fs_write', path: neighbour, real: neighbour }), 'the scope is the generated dir alone').toBe(false);
  });

  it('CATEGORY CONVERTED: the email attachment reader reads through the facade', () => {
    const src = fs.readFileSync(path.join(SRC, 'services/email-attachments.ts'), 'utf8');
    expect(/^import .*['"]node:fs['"]/m.test(src), 'the attachment reader must not hold node:fs').toBe(false);
    expect(src.includes('effectFs.'), 'it reads through the facade').toBe(true);
  });

  it('gmail_send / outlook_send authorize exactly the attachments the call names', () => {
    const a = path.join(scratch, 'quote.pdf');
    for (const tool of ['gmail_send', 'outlook_send']) {
      const grants = grantsForCall(AGENT, effectsFor(tool), { to: 'x@y.z', attachments: [a] });
      expect(grantsCover(grants, { op: 'fs_read', path: a, real: a }), `${tool} may read what it was given`).toBe(true);
      expect(grantsCover(grants, { op: 'fs_read', path: outOfScope, real: outOfScope }), `${tool} may not read anything else`).toBe(false);
      // A read of an attachment is not a licence to write over it.
      expect(grantsCover(grants, { op: 'fs_write', path: a, real: a })).toBe(false);
    }
  });

  it('CATEGORY CONVERTED: the recall door reads the large-file store through the facade', () => {
    const src = fs.readFileSync(path.join(SRC, 'memory/large-files.ts'), 'utf8');
    expect(/^import .*['"]node:fs['"]/m.test(src), 'the large-file store must not hold node:fs').toBe(false);
    expect(src.includes('effectFs.'), 'it reads and writes through the facade').toBe(true);
  });

  it('history_get DECLARES the large-file store it reads, and the scope is that store alone', () => {
    // Same shape as `open_browser`: `history_get` has always read the stored
    // body of a `file_*` id off disk and declared NO fs effect at all, so the
    // converted call site refused until the declaration was corrected AT THE
    // SITE with its reason (RULING P5-R14). The scope is the store's own tree
    // because that is what the tool reads — the row's `storage_path` is chosen
    // by the platform, and the per-agent ownership check stays exactly where it
    // is, after the read, so no message the owner sees changes.
    const grants = grantsForCall(AGENT, effectsFor('history_get'), { id: 'file_x' });
    const store = path.join(os.homedir(), '.dojo', 'data', 'files');
    const stored = path.join(store, 'some-agent', 'file_x.txt');
    expect(grantsCover(grants, { op: 'fs_read', path: stored, real: stored }), 'it may read a stored body').toBe(true);
    // …and nothing else under the same parent, which is what makes it a scope.
    const sibling = path.join(os.homedir(), '.dojo', 'data', 'dojo.db');
    expect(grantsCover(grants, { op: 'fs_read', path: sibling, real: sibling }), 'the scope is the store alone').toBe(false);
    // A read declaration is not a write one.
    expect(grantsCover(grants, { op: 'fs_write', path: stored, real: stored })).toBe(false);
  });

  it('CATEGORY CONVERTED: the async audio delivery path writes through the facade', () => {
    // RECLASSIFIED by the RULING P5-R15 ADDENDUM re-read: both modules had been
    // recorded as platform-timed, and the sharpened criterion is whose async
    // context the I/O runs in. Re-derived by command at this HEAD — `deliverAsset`
    // has ONE call site, reached only from `runAudioOrMusicJob`, reached only
    // from `enqueueAudioOrMusicJob`, whose ONE production caller is the
    // tts_create / music_create handler; the boot worker calls `setFailed` and
    // `deliverError` and never reaches an fs line at all.
    for (const file of ['services/generation-jobs.ts', 'services/audio-generation.ts']) {
      const src = fs.readFileSync(path.join(SRC, file), 'utf8');
      expect(/^import .*['"]node:fs['"]/m.test(src), `${file} must not hold node:fs`).toBe(false);
      expect(src.includes('effectFs.'), `${file} must write through the facade`).toBe(true);
    }
  });

  it('tts_create and music_create DECLARE the generated dir AND their own delivery copy', () => {
    const generatedDir = path.join(os.homedir(), '.dojo', 'uploads', 'generated');
    const wav = path.join(generatedDir, 'x.wav');
    const uploads = path.join(os.homedir(), '.dojo', 'uploads', AGENT);
    const stable = path.join(uploads, 'weekly-recap-1234.wav');
    for (const tool of ['tts_create', 'music_create']) {
      const grants = grantsForCall(AGENT, effectsFor(tool), { text: 'hello', description: 'a beat' });
      expect(grantsCover(grants, { op: 'fs_mkdir', path: generatedDir, real: generatedDir }), `${tool} may create the generated dir`).toBe(true);
      expect(grantsCover(grants, { op: 'fs_write', path: wav, real: wav }), `${tool} may write the asset`).toBe(true);
      expect(grantsCover(grants, { op: 'fs_read', path: wav, real: wav }), `${tool} may read it back to deliver it`).toBe(true);
      expect(grantsCover(grants, { op: 'fs_write', path: stable, real: stable }), `${tool} may place the delivery copy`).toBe(true);
      const other = path.join(os.homedir(), '.dojo', 'uploads', 'someone-else', 'x.wav');
      expect(grantsCover(grants, { op: 'fs_write', path: other, real: other }), `${tool} may not write another agent uploads dir`).toBe(false);
    }
  });

  it('CATEGORY CONVERTED: the media door reads and delivers through the facade', () => {
    const src = fs.readFileSync(path.join(SRC, 'agent/tools/cat/media.ts'), 'utf8');
    expect(/^import .*['"]node:fs['"]/m.test(src), 'the media door must not hold node:fs').toBe(false);
    expect(src.includes('effectFs.'), 'it reads and writes through the facade').toBe(true);
  });

  it('image_create may read BACK what it generated and copy it into the caller uploads dir', () => {
    // The delivery copy is a READ of the generated file and a WRITE of the
    // caller's own uploads directory. The first was never declared (the
    // generated-directory effect declared only the write) and the second had
    // prose with no machine-checkable scope, so both were corrected at the site.
    const grants = grantsForCall(AGENT, effectsFor('image_create'), { description: 'a cat' });
    const generated = path.join(os.homedir(), '.dojo', 'uploads', 'generated', 'x.png');
    const uploads = path.join(os.homedir(), '.dojo', 'uploads', AGENT);
    const stable = path.join(uploads, 'a-cat-1234.png');
    expect(grantsCover(grants, { op: 'fs_read', path: generated, real: generated }), 'it may read back its own output').toBe(true);
    expect(grantsCover(grants, { op: 'fs_mkdir', path: uploads, real: uploads }), 'it may create the caller uploads dir').toBe(true);
    expect(grantsCover(grants, { op: 'fs_write', path: stable, real: stable }), 'it may place the stable copy there').toBe(true);
    const other = path.join(os.homedir(), '.dojo', 'uploads', 'someone-else', 'x.png');
    expect(grantsCover(grants, { op: 'fs_write', path: other, real: other }), 'and never another agent uploads dir').toBe(false);
  });

  it('MECHANIC 5: an attachment id resolves to the EXACT recorded path, and to nothing else', () => {
    // RULING P5-R15 ADDENDUM. `transcribe_audio` takes an `attachment_id`, not a
    // path — the resource is named INDIRECTLY, through a recorded row. There is
    // no tree to declare (attachment paths sit under several roots), so the
    // resolver performs the SAME read the handler performs, at gate-loop time,
    // and mints the grant for the one path that row records.
    const recorded = path.join(scratch, 'voice-note.m4a');
    fs.writeFileSync(recorded, 'audio');
    const grants = grantsForCall(
      AGENT,
      [{ kind: 'fs_read', from: 'args.attachment_id', via: 'attachment_row' } as ToolEffect],
      { attachment_id: 'file_known' },
      { attachment_row: (id) => (id === 'file_known' ? { path: recorded } : null) },
    );
    expect(grants).toHaveLength(1);
    expect(grantsCover(grants, { op: 'fs_read', path: recorded, real: recorded })).toBe(true);
    expect(grantsCover(grants, { op: 'fs_read', path: outOfScope, real: outOfScope }), 'the id names ONE file').toBe(false);
  });

  it('…and an id that resolves to NOTHING yields no grant, so the handler keeps its own error', () => {
    // The failure surface for a missing or stale id must stay the handler's own
    // message ("no attachment found with id X"), never a bare facade refusal:
    // the handler returns before it touches the disk, so no facade call happens.
    const e = [{ kind: 'fs_read', from: 'args.attachment_id', via: 'attachment_row' } as ToolEffect];
    const lookup = { attachment_row: (): null => null };
    expect(grantsForCall(AGENT, e, { attachment_id: 'file_gone' }, lookup)).toEqual([]);
    expect(grantsForCall(AGENT, e, {}, lookup), 'absent argument').toEqual([]);
    expect(grantsForCall(AGENT, e, { attachment_id: 42 }, lookup), 'non-string id').toEqual([]);
  });

  it('transcribe_audio DECLARES both of its sources: the recorded attachment and the given path', () => {
    const given = path.join(scratch, 'clip.wav');
    const grants = grantsForCall(AGENT, effectsFor('transcribe_audio'), { path: given });
    expect(grantsCover(grants, { op: 'fs_read', path: given, real: given }), 'the path it was handed').toBe(true);
    expect(grantsCover(grants, { op: 'fs_read', path: outOfScope, real: outOfScope })).toBe(false);
    // The indirection is DECLARED on the tool, so a later edit cannot drop it silently.
    expect(
      effectsFor('transcribe_audio')?.some((x) => x.via === 'attachment_row'),
      'transcribe_audio must declare the attachment-row indirection',
    ).toBe(true);
  });

  it('CATEGORY CONVERTED: the comms door reads and copies through the facade', () => {
    const src = fs.readFileSync(path.join(SRC, 'agent/tools/cat/comms.ts'), 'utf8');
    expect(/^import .*['"]node:fs['"]/m.test(src), 'the comms door must not hold node:fs').toBe(false);
    expect(src.includes('effectFs.'), 'it reaches files through the facade').toBe(true);
  });

  it("show_to_user DECLARES the uploads directory it copies into, and the scope is that agent's alone", () => {
    // `show_to_user` copies whatever it is shown INTO `~/.dojo/uploads/<agentId>`
    // so the dashboard's serve route can find it, and declared only the read of
    // the source. Corrected at the site with its reason (RULING P5-R14); it adds
    // no refusal, because gate rows are declared in `tools/gates.ts` and are
    // never derived from `effects[]` (P5-R5).
    const shown = path.join(scratch, 'photo.png');
    const grants = grantsForCall(AGENT, effectsFor('show_to_user'), { file_paths: [shown] });
    const uploads = path.join(os.homedir(), '.dojo', 'uploads', AGENT);
    const copy = path.join(uploads, '1_photo.png');
    expect(grantsCover(grants, { op: 'fs_read', path: shown, real: shown }), 'it may read what it was asked to show').toBe(true);
    expect(grantsCover(grants, { op: 'fs_mkdir', path: uploads, real: uploads }), 'it may create its own uploads directory').toBe(true);
    expect(grantsCover(grants, { op: 'fs_write', path: copy, real: copy }), 'it may copy the file in for the serve route').toBe(true);
    // …and never into ANOTHER agent's uploads directory, which is what makes it a scope.
    const other = path.join(os.homedir(), '.dojo', 'uploads', 'someone-else', 'x.png');
    expect(grantsCover(grants, { op: 'fs_write', path: other, real: other }), "the scope is this agent's uploads alone").toBe(false);
    // A read of the source is not a licence to overwrite it.
    expect(grantsCover(grants, { op: 'fs_write', path: shown, real: shown })).toBe(false);
  });

  it('share_file and imessage_send probe exactly the files their call named', () => {
    const doc = path.join(scratch, 'quote.pdf');
    const shareGrants = grantsForCall(AGENT, effectsFor('share_file'), { path: doc });
    expect(grantsCover(shareGrants, { op: 'fs_stat', path: doc, real: doc })).toBe(true);
    expect(grantsCover(shareGrants, { op: 'fs_stat', path: outOfScope, real: outOfScope })).toBe(false);
    const imGrants = grantsForCall(AGENT, effectsFor('imessage_send'), {
      recipient: '+15550100', message: 'hi', attachments: [doc],
    });
    expect(grantsCover(imGrants, { op: 'fs_stat', path: doc, real: doc })).toBe(true);
    expect(grantsCover(imGrants, { op: 'fs_stat', path: outOfScope, real: outOfScope })).toBe(false);
  });

  it("open_browser DECLARES the directory it writes, and the declaration covers exactly that", () => {
    // The screenshot fallback has always written a PNG to disk and the tool
    // declared no fs effect at all — so a converted call site would have been
    // refused. RULING P5-R14: a declaration proven too narrow is CORRECTED with
    // its reason recorded at the site, never worked around at the call site.
    // Adding the effect adds no refusal: gates are declared in `tools/gates.ts`
    // and are not derived from `effects[]` (RULING P5-R5), so this widens what
    // the facade will carry and gates nothing new.
    const grants = grantsForCall(AGENT, effectsFor('open_browser'), { url: 'https://example.com' });
    const shotsDir = path.join(os.homedir(), '.dojo', 'data', 'canvas-shots');
    const png = path.join(shotsDir, 'a-screenshot.png');
    expect(grantsCover(grants, { op: 'fs_mkdir', path: shotsDir, real: shotsDir }), 'it may create its own directory').toBe(true);
    expect(grantsCover(grants, { op: 'fs_write', path: png, real: png }), 'it may write the screenshot').toBe(true);
    // …and nothing else under the same parent, which is what makes it a scope.
    const sibling = path.join(os.homedir(), '.dojo', 'data', 'dojo.db');
    expect(grantsCover(grants, { op: 'fs_write', path: sibling, real: sibling }), 'the scope is the shots dir alone').toBe(false);
  });
});
