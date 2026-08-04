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
import { decodeToWav16kMono, extractAudioFromVideo } from '../transcode.js';
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
    expect(Object.keys(INDIRECT_RESOLVERS)).toEqual(
      ['attachment_row', 'technique_dir', 'agent_canvas_file', 'office_local_path'],
    );
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

  it('CATEGORY CONVERTED: the file door reads, writes, appends, patches and lists through the facade', () => {
    const src = fs.readFileSync(path.join(SRC, 'agent/tools/cat/fs.ts'), 'utf8');
    expect(/^import .*['"]node:fs['"]/m.test(src), 'the file door must not hold node:fs').toBe(false);
    expect(src.includes('effectFs.'), 'it reaches the disk through the facade').toBe(true);
    // The toolbox tree now has exactly ONE remaining direct holder, and it is
    // NAMED rather than allowed by a pattern: `agent/tools/util.ts` converts
    // LAST because its three probes run on the CALLER's grant — every tool that
    // hands it a path must declare that path first — and because its own
    // `catch` returns null, so a premature conversion would narrow silently
    // (no download URL, no canvas chip) instead of refusing loudly. When it
    // converts, this list becomes empty and the toolbox grep-zero is complete.
    expect(
      filesContaining("from 'node:fs'", path.join(SRC, 'agent', 'tools')),
      'agent/tools/** reaches the disk through the facade except the named last file',
    ).toEqual(['agent/tools/util.ts']);
  });

  it('MECHANIC 6: the atomic write owns its temp sibling, and the DECLARED resource is the target', async () => {
    // RULING P5-R15 ADDENDUM. `file_patch` wrote `.<name>.patch-<ts>-<rand>.tmp`
    // beside the target and renamed it. The grant from `args.path` names the
    // TARGET, so the tmp write was refused — the mechanism had to move into the
    // carrying layer whole rather than the declaration having to describe a file
    // the tool does not name and the user never sees.
    const target = path.join(scratch, 'patched.txt');
    fs.writeFileSync(target, 'before\n');
    await inCall([pathGrant('fs_write', target)], 'file_patch', async () => {
      await effectFs.atomicWriteFile(target, 'after\n', 'utf-8');
    });
    expect(fs.readFileSync(target, 'utf8')).toBe('after\n');
    // The temp sibling did not survive the rename, and nothing else appeared.
    expect(fs.readdirSync(scratch).filter((n) => n.includes('.tmp'))).toEqual([]);
    // …and it is still an authorization: a target this call did not declare is refused.
    await inCall([pathGrant('fs_write', target)], 'file_patch', async () => {
      await expect(effectFs.atomicWriteFile(outOfScope, 'x', 'utf-8')).rejects.toBeInstanceOf(EffectNotAuthorized);
    });
  });

  it('file_list DECLARES the tree it lists, so the size column SURVIVES the conversion', () => {
    // T8C §5d: the handler stats every entry INSIDE the listed directory, the
    // grant from `args.path` was `at:'path'` on the directory alone, and the
    // handler's own `catch` turns a refusal into `-`. Converted as-is, every
    // entry's size would have silently become a dash. That is the silent
    // narrowing this task exists to prevent, so the RESOLVER learned to express
    // the declared tree — never a call-site workaround.
    const dir = path.join(scratch, 'listing');
    fs.mkdirSync(dir, { recursive: true });
    const entry = path.join(dir, 'inside.txt');
    fs.writeFileSync(entry, 'x');
    const grants = grantsForCall(AGENT, effectsFor('file_list'), { path: dir });
    expect(grantsCover(grants, { op: 'fs_stat', path: dir, real: dir }), 'the directory itself').toBe(true);
    expect(grantsCover(grants, { op: 'fs_read', path: dir, real: dir }), 'readdir of the directory').toBe(true);
    expect(grantsCover(grants, { op: 'fs_stat', path: entry, real: entry }), 'AND every entry inside it').toBe(true);
    // …and it is still a scope: the parent and a sibling directory are not covered.
    const sibling = path.join(scratch, 'listing-other', 'x.txt');
    expect(grantsCover(grants, { op: 'fs_stat', path: sibling, real: sibling }), 'not a neighbour').toBe(false);
    expect(grantsCover(grants, { op: 'fs_stat', path: outOfScope, real: outOfScope }), 'not the parent contents').toBe(false);
    // A LIST is not a licence to write.
    expect(grantsCover(grants, { op: 'fs_write', path: entry, real: entry })).toBe(false);
  });

  it('…and file_read is still ONE file, which is what makes argTree a scope rather than a habit', () => {
    const dir = path.join(scratch, 'listing');
    const entry = path.join(dir, 'inside.txt');
    const grants = grantsForCall(AGENT, effectsFor('file_read'), { path: dir });
    expect(grantsCover(grants, { op: 'fs_read', path: dir, real: dir })).toBe(true);
    expect(grantsCover(grants, { op: 'fs_read', path: entry, real: entry }), 'file_read does not gain a tree').toBe(false);
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

  it('MECHANIC 7: a path one level INSIDE an array element resolves, and an element without it grants nothing', () => {
    // RULING P5-R15 ADDENDUM 2. `pdf_create` takes `content` blocks and an
    // `image` block carries `{ path }`. The bare array mechanic resolves each
    // ELEMENT as a path, so an element that is an object granted nothing and the
    // converted site would have refused a documented, live capability.
    const a = path.join(scratch, 'chart.png');
    const b = path.join(scratch, 'logo.png');
    const imageBlocks: ToolEffect = { kind: 'fs_read', from: 'args.content[].path' };
    const grants = grantsForCall(AGENT, [imageBlocks], {
      content: [
        { type: 'heading', text: 'Q3' },            // no path — grants nothing
        { type: 'image', path: a },
        { type: 'paragraph', text: 'body' },        // no path — grants nothing
        { type: 'image', path: b },
      ],
    });
    expect(grants).toHaveLength(2);
    expect(grantsCover(grants, { op: 'fs_read', path: a, real: a })).toBe(true);
    expect(grantsCover(grants, { op: 'fs_read', path: b, real: b })).toBe(true);
    expect(grantsCover(grants, { op: 'fs_read', path: outOfScope, real: outOfScope }), 'and nothing else').toBe(false);
  });

  it('…and mechanic 7 narrows rather than widens on every malformed shape', () => {
    const e = (args: Record<string, unknown>): unknown[] =>
      grantsForCall(AGENT, [{ kind: 'fs_read', from: 'args.content[].path' } as ToolEffect], args);
    expect(e({}), 'absent').toEqual([]);
    expect(e({ content: [] }), 'empty list').toEqual([]);
    expect(e({ content: [inScope] }), 'a bare string element has no property').toEqual([]);
    expect(e({ content: [{ path: 42 }] }), 'non-string property').toEqual([]);
    expect(e({ content: [{ notpath: inScope }] }), 'a different property').toEqual([]);
    expect(e({ content: 'x' }), 'not a list at all').toEqual([]);
    // …and the BARE array mechanic is unchanged by mechanic 7 living beside it.
    expect(grantsForCall(AGENT, [{ kind: 'fs_read', from: 'args.attachments[]' } as ToolEffect], { attachments: [inScope] })).toHaveLength(1);
  });

  it('CATEGORY CONVERTED: the PDF door reads and writes through the facade', () => {
    const src = fs.readFileSync(path.join(SRC, 'agent/pdf-tools.ts'), 'utf8');
    expect(/^import .*['"]node:fs['"]/m.test(src), 'the PDF door must not hold node:fs').toBe(false);
    expect(src.includes('effectFs.'), 'it reaches the disk through the facade').toBe(true);
  });

  it('the pdf tools DECLARE the uploads dir they really write, never the bare filename they were given', () => {
    // RULING P5-R15 ADDENDUM 2's ordinary site correction. `filename` /
    // `output_filename` are BARE NAMES: resolved as paths they named a file
    // relative to the server's working directory — a resource these tools never
    // touch — while the real write, `~/.dojo/uploads/<agentId>/<sanitised>.pdf`,
    // went undeclared. The declaration both missed the real write and named a
    // false one, and the conversion is what forced it into the open.
    const uploads = path.join(os.homedir(), '.dojo', 'uploads', AGENT);
    const out = path.join(uploads, 'report.pdf');
    const source = path.join(scratch, 'source.pdf');
    for (const tool of ['pdf_merge', 'pdf_extract_pages', 'pdf_rotate_pages', 'pdf_reorder_pages',
      'pdf_delete_pages', 'pdf_watermark', 'pdf_fill_form']) {
      const grants = grantsForCall(AGENT, effectsFor(tool), {
        path: source, input_paths: [source], output_filename: 'report.pdf',
      });
      expect(grantsCover(grants, { op: 'fs_mkdir', path: uploads, real: uploads }), `${tool} may create its uploads dir`).toBe(true);
      expect(grantsCover(grants, { op: 'fs_write', path: out, real: out }), `${tool} may write its output`).toBe(true);
      expect(grantsCover(grants, { op: 'fs_read', path: source, real: source }), `${tool} may read its input`).toBe(true);
      // …and never another agent's uploads directory, which is what makes it a scope.
      const other = path.join(os.homedir(), '.dojo', 'uploads', 'someone-else', 'x.pdf');
      expect(grantsCover(grants, { op: 'fs_write', path: other, real: other }), `${tool} may not write elsewhere`).toBe(false);
      // A read of the input is not a licence to overwrite it in place.
      expect(grantsCover(grants, { op: 'fs_write', path: source, real: source }), `${tool} may not overwrite its input`).toBe(false);
    }
  });

  it('pdf_create DECLARES its output dir AND the image blocks it embeds', () => {
    const img = path.join(scratch, 'chart.png');
    const grants = grantsForCall(AGENT, effectsFor('pdf_create'), {
      filename: 'deck.pdf',
      content: [{ type: 'image', path: img }],
    });
    const uploads = path.join(os.homedir(), '.dojo', 'uploads', AGENT);
    const out = path.join(uploads, 'deck.pdf');
    expect(grantsCover(grants, { op: 'fs_write', path: out, real: out }), 'it may write the PDF').toBe(true);
    expect(grantsCover(grants, { op: 'fs_read', path: img, real: img }), 'it may read the image it embeds').toBe(true);
    expect(grantsCover(grants, { op: 'fs_read', path: outOfScope, real: outOfScope }), 'and no other image').toBe(false);
  });

  it('SURFACE SPLIT: the tool-doc READER is its own module and reads through the facade', () => {
    // RULING P5-R15 part 2. `tools/index-generator.ts` held one `node:fs` import
    // serving two populations: a boot job that WRITES every tool doc, and a
    // reader called inside `load_tool_docs`. Neither classification was honest
    // while they shared a module, so the surfaces were separated — the reader
    // moved out because the file's own name and header describe the generator.
    const reader = fs.readFileSync(path.join(SRC, 'tools/tool-doc-read.ts'), 'utf8');
    expect(/^import .*['"]node:fs['"]/m.test(reader), 'the reader must not hold node:fs').toBe(false);
    expect(reader.includes('effectFs.'), 'it reads through the facade').toBe(true);
    // …and the generator half kept the boot job, so its import is honestly
    // platform-internal: it has exactly one caller and that caller is boot.
    expect(filesContaining('generateToolDocs(')).toEqual(['index.ts', 'tools/index-generator.ts']);
    expect(filesContaining('readToolDoc('), 'the reader has one caller and it is a tool handler chain')
      .toEqual(['tools/tool-doc-read.ts', 'tools/tool-docs.ts']);
  });

  it('load_tool_docs DECLARES the docs directory it reads, and the scope is that directory alone', () => {
    const grants = grantsForCall(AGENT, effectsFor('load_tool_docs'), { tools: ['web_fetch'] });
    const docsDir = path.join(os.homedir(), '.dojo', 'tools');
    const doc = path.join(docsDir, 'web_fetch.md');
    expect(grantsCover(grants, { op: 'fs_stat', path: doc, real: doc }), 'it may probe a doc').toBe(true);
    expect(grantsCover(grants, { op: 'fs_read', path: doc, real: doc }), 'it may read a doc').toBe(true);
    // …and nothing outside the directory, which is what makes it a scope.
    const outside = path.join(os.homedir(), '.dojo', 'data', 'dojo.db');
    expect(grantsCover(grants, { op: 'fs_read', path: outside, real: outside }), 'the scope is the docs dir alone').toBe(false);
    // A read of the docs is not a licence to write them — the generator's job.
    expect(grantsCover(grants, { op: 'fs_write', path: doc, real: doc })).toBe(false);
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

  it('APPLICATION (a): a reference resolves to the TREE of its recorded directory, and to nothing else', () => {
    // RULING P5-R15 ADDENDUM 3(1)(a). Mechanic 5 resolves an identifier to ONE
    // recorded path; the techniques cluster names a DIRECTORY the tool works
    // inside. The reference an agent passes is an id, a slug OR a display name,
    // resolved through the same DB read the handler performs, so no template
    // scope can name the directory — the resolution has to be the platform's own.
    const dir = path.join(scratch, 'technique-alpha');
    fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
    const nested = path.join(dir, 'templates', 'brief.md');
    fs.writeFileSync(nested, '# brief\n');
    const declaration: ToolEffect = { kind: 'fs_read', from: 'args.name', via: 'technique_dir', scope: { at: 'argTree' } };
    const grants = grantsForCall(AGENT, [declaration], { name: 'Alpha Technique' }, {
      attachment_row: () => null,
      technique_dir: (ref) => (ref === 'Alpha Technique' ? { path: dir } : null),
    });
    expect(grantsCover(grants, { op: 'fs_read', path: dir, real: dir }), 'the directory itself').toBe(true);
    expect(grantsCover(grants, { op: 'fs_read', path: nested, real: nested }), 'and what is nested inside it').toBe(true);
    expect(grantsCover(grants, { op: 'fs_read', path: outOfScope, real: outOfScope }), 'and nothing outside it').toBe(false);
    // A read of the tree is not a licence to write it — the kinds stay separate.
    expect(grantsCover(grants, { op: 'fs_write', path: nested, real: nested })).toBe(false);
    // …and the SAME indirection without the tree scope is still ONE path, which
    // is what makes `argTree` a declaration rather than a habit.
    const one = grantsForCall(AGENT, [{ kind: 'fs_read', from: 'args.name', via: 'technique_dir' } as ToolEffect], { name: 'Alpha Technique' }, {
      attachment_row: () => null,
      technique_dir: () => ({ path: dir }),
    });
    expect(grantsCover(one, { op: 'fs_read', path: nested, real: nested }), 'no tree was declared').toBe(false);
  });

  it('…and a reference that resolves to NOTHING yields no grant, so the handler keeps its own error', () => {
    // `resolveTechniqueRef` already answers a bad reference with its own message
    // ("Technique X not found. Use list_techniques…") and the handler returns
    // before it touches disk. A stale reference must never become a bare refusal.
    const e = [{ kind: 'fs_read', from: 'args.name', via: 'technique_dir', scope: { at: 'argTree' } } as ToolEffect];
    const lookup = { attachment_row: (): null => null, technique_dir: (): null => null };
    expect(grantsForCall(AGENT, e, { name: 'no-such-technique' }, lookup)).toEqual([]);
    expect(grantsForCall(AGENT, e, {}, lookup), 'absent argument').toEqual([]);
    expect(grantsForCall(AGENT, e, { name: 42 }, lookup), 'non-string reference').toEqual([]);
  });

  it('CATEGORY CONVERTED: the techniques door reads and writes through the facade', () => {
    const src = fs.readFileSync(path.join(SRC, 'techniques/tools.ts'), 'utf8');
    expect(/^import .*['"]node:fs['"]/m.test(src), 'the techniques door must not hold node:fs').toBe(false);
    expect(src.includes('effectFs.'), 'it reaches the disk through the facade').toBe(true);
  });

  it('ONE RESOLUTION POINT: the gate loop and the handler ask the same reader the same question', () => {
    // The same-reader principle is structural here, not hoped: the identity read
    // (`resolveTechniqueRef` → the recorded row) lives in ONE leaf the gate loop
    // can import without dragging the store's own fs, embeddings and broadcast
    // into every dispatch's module graph, and the store re-exports it so no
    // consumer moved.
    const leaf = fs.readFileSync(path.join(SRC, 'techniques/technique-dir.ts'), 'utf8');
    expect(/^import .*['"]node:fs['"]/m.test(leaf), 'the resolution leaf holds no fs of its own').toBe(false);
    expect(filesContaining('function resolveTechniqueRef('), 'the reference reader exists in exactly one place')
      .toEqual(['techniques/technique-dir.ts']);
    expect(filesContaining('function techniqueDirectory('), 'and so does the reference → directory mapping')
      .toEqual(['techniques/technique-dir.ts']);
  });

  it('technique_read DECLARES the technique tree it walks, so its search keeps finding supporting files', () => {
    // The handler's own `catch` around the walk turns a refusal into a logged
    // warning and NO hits — the `file_list` failure mode exactly: converted on a
    // single-path grant, `action="search"` would silently stop matching every
    // supporting file and nothing anywhere would fail.
    const dir = path.join(scratch, 'technique-beta');
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    const support = path.join(dir, 'sub', 'server.py');
    const grants = grantsForCall(AGENT, effectsFor('technique_read'), { name: 'beta', action: 'search', query: 'x' }, {
      attachment_row: () => null,
      technique_dir: () => ({ path: dir }),
    });
    expect(grantsCover(grants, { op: 'fs_read', path: dir, real: dir }), 'it may list the directory').toBe(true);
    expect(grantsCover(grants, { op: 'fs_read', path: support, real: support }), 'it may read a nested supporting file').toBe(true);
    expect(grantsCover(grants, { op: 'fs_stat', path: support, real: support }), 'it may probe one').toBe(true);
    expect(grantsCover(grants, { op: 'fs_read', path: outOfScope, real: outOfScope }), 'and nothing outside the technique').toBe(false);
    // A read is not a licence to write: `technique_read` writes nothing.
    expect(grantsCover(grants, { op: 'fs_write', path: support, real: support })).toBe(false);
    // The indirection is DECLARED on the tool, so a later edit cannot drop it silently.
    expect(
      effectsFor('technique_read')?.some((x) => x.via === 'technique_dir' && x.scope?.at === 'argTree'),
      'technique_read must declare the technique-directory tree',
    ).toBe(true);
  });

  it('update_technique DECLARES the technique tree it writes, never the relative name it was given', () => {
    // `files[].path` is a RELATIVE path inside the technique directory. Resolved
    // as a path of its own it named a file in the server's working directory the
    // tool never touches, while the real write — `<technique dir>/<that name>` —
    // went undeclared. Same class as the PDF door's bare filename, and the
    // conversion is what forced it into the open.
    const dir = path.join(scratch, 'technique-gamma');
    fs.mkdirSync(dir, { recursive: true });
    const written = path.join(dir, 'templates', 'brief.md');
    const grants = grantsForCall(AGENT, effectsFor('update_technique'), {
      name: 'gamma', change_summary: 'x', files: [{ path: 'templates/brief.md', content: 'hi' }],
    }, {
      attachment_row: () => null,
      technique_dir: () => ({ path: dir }),
    });
    expect(grantsCover(grants, { op: 'fs_mkdir', path: path.dirname(written), real: path.dirname(written) }), 'it may create the subdirectory').toBe(true);
    expect(grantsCover(grants, { op: 'fs_write', path: written, real: written }), 'it may write the supporting file').toBe(true);
    // …and never the cwd-relative resolution of the same name, which is what the
    // declaration used to say and what it never touched.
    const false_ = path.resolve('templates/brief.md');
    expect(grantsCover(grants, { op: 'fs_write', path: false_, real: false_ }), 'the bare relative name grants nothing').toBe(false);
    expect(grantsCover(grants, { op: 'fs_write', path: outOfScope, real: outOfScope }), 'and nothing outside the technique').toBe(false);
  });

  it('SURFACE SPLIT: the imported-technique setup surface is its own module and reaches disk through the facade', () => {
    // RULING P5-R15 part 2. `techniques/share-import.ts` held one `node:fs`
    // import serving two populations: the package IMPORT, whose only caller is
    // the dashboard upload route, and the placeholder SETUP surface, whose only
    // caller is the technique tool-handler module. The two partition perfectly by
    // enclosing function — 10 sites on the import side, 8 on the setup side, and
    // only a module-private manifest TYPE is shared, which crosses as a type-only
    // import and therefore not at runtime at all.
    const setup = fs.readFileSync(path.join(SRC, 'techniques/import-setup.ts'), 'utf8');
    expect(/^import .*['"]node:fs['"]/m.test(setup), 'the setup surface must not hold node:fs').toBe(false);
    expect(setup.includes('effectFs.'), 'it reaches the disk through the facade').toBe(true);
    // …and each half has exactly the callers its classification claims.
    expect(filesContaining('importTechnique('), 'the import half is reached by the dashboard route alone')
      .toEqual(['gateway/routes/techniques.ts', 'techniques/share-import.ts']);
    expect(filesContaining('applyPlaceholderToTechnique('), 'the setup half is reached by the tool handlers alone')
      .toEqual(['techniques/import-setup.ts', 'techniques/tools.ts']);
    expect(filesContaining('finalizeImportedTechnique('))
      .toEqual(['techniques/import-setup.ts', 'techniques/tools.ts']);
  });

  it('technique_set_placeholder DECLARES the READ it has always performed, not only the write', () => {
    // It reads the staged manifest and every file the placeholder appears in
    // before it substitutes — and declared only `fs_write`. Converted as-is the
    // first read would have been refused. RULING P5-R14: the declaration is
    // corrected AT THE SITE with its reason, and it adds no refusal because gate
    // rows are declared in `tools/gates.ts`, never derived from `effects[]`.
    const dir = path.join(scratch, 'technique-delta');
    fs.mkdirSync(dir, { recursive: true });
    const staged = path.join(dir, 'IMPORT_MANIFEST.json');
    const target = path.join(dir, 'config', 'settings.json');
    const grants = grantsForCall(AGENT, effectsFor('technique_set_placeholder'), {
      technique: 'delta', label: 'API_KEY', value: 'x',
    }, { attachment_row: () => null, technique_dir: () => ({ path: dir }) });
    expect(grantsCover(grants, { op: 'fs_read', path: staged, real: staged }), 'it may read the staged manifest').toBe(true);
    expect(grantsCover(grants, { op: 'fs_read', path: target, real: target }), 'it may read a file the placeholder is in').toBe(true);
    expect(grantsCover(grants, { op: 'fs_write', path: target, real: target }), 'it may write the substitution back').toBe(true);
    expect(grantsCover(grants, { op: 'fs_read', path: outOfScope, real: outOfScope }), 'and nothing outside the technique').toBe(false);
    expect(grantsCover(grants, { op: 'fs_write', path: outOfScope, real: outOfScope })).toBe(false);
  });

  it('technique_finalize DECLARES what it really does — it reads and deletes, and never wrote', () => {
    const dir = path.join(scratch, 'technique-epsilon');
    fs.mkdirSync(dir, { recursive: true });
    const staged = path.join(dir, 'IMPORT_MANIFEST.json');
    const grants = grantsForCall(AGENT, effectsFor('technique_finalize'), { technique: 'epsilon' }, {
      attachment_row: () => null, technique_dir: () => ({ path: dir }),
    });
    expect(grantsCover(grants, { op: 'fs_read', path: staged, real: staged }), 'it may read to confirm no placeholder remains').toBe(true);
    expect(grantsCover(grants, { op: 'fs_delete', path: staged, real: staged }), 'it may remove the staged manifest').toBe(true);
    expect(grantsCover(grants, { op: 'fs_delete', path: outOfScope, real: outOfScope }), 'and nothing outside the technique').toBe(false);
    // The `fs_write` it used to declare was never performed by any of its code
    // paths — the state flip is a DB update — so the declaration named an effect
    // that did not exist rather than one that was missing.
    expect(effectsFor('technique_finalize')?.some((e) => e.kind === 'fs_write'), 'it writes no file').toBe(false);
  });

  it('APPLICATION (b): the CALL\'S OWN AGENT IDENTITY resolves the per-agent recorded resource', () => {
    // RULING P5-R15 ADDENDUM 3(1)(b). `canvas_read` takes a `prompt` and nothing
    // else — its schema has no path at all, and its one production call site
    // passes `{ prompt }`. The file it reads is the one the agent put on its own
    // canvas EARLIER, recorded per agent, so there is no argument to resolve and
    // a declaration in terms of arguments cannot describe it. The identity of the
    // call is the resolution key, read through the same function the handler
    // reads the canvas with.
    const shown = path.join(scratch, 'report.html');
    const declaration: ToolEffect = {
      kind: 'fs_read', from: 'derived:the file currently on this agent canvas',
      scope: { at: 'agentResolved', via: 'agent_canvas_file' },
    };
    const seen: string[] = [];
    const grants = grantsForCall(AGENT, [declaration], { prompt: 'what is this' }, {
      attachment_row: () => null,
      technique_dir: () => null,
      agent_canvas_file: (id) => { seen.push(id); return id === AGENT ? { path: shown } : null; },
    });
    expect(seen, 'the resolver is asked about THIS call\'s agent, nobody else').toEqual([AGENT]);
    expect(grantsCover(grants, { op: 'fs_read', path: shown, real: shown }), 'it may read what it put there').toBe(true);
    expect(grantsCover(grants, { op: 'fs_stat', path: shown, real: shown }), 'it may probe it first').toBe(true);
    expect(grantsCover(grants, { op: 'fs_read', path: outOfScope, real: outOfScope }), 'and no other file').toBe(false);
    // A read of the canvas is not a licence to overwrite it.
    expect(grantsCover(grants, { op: 'fs_write', path: shown, real: shown })).toBe(false);
    // An agent with NOTHING on its canvas gets no grant at all, which leaves the
    // handler's own "nothing is open in the canvas" message intact.
    expect(grantsForCall('someone-else', [declaration], {}, {
      attachment_row: () => null, technique_dir: () => null, agent_canvas_file: () => null,
    })).toEqual([]);
  });

  it('3-WAY SPLIT: the canvas viewer, its per-agent state, and the disk watcher are three modules', () => {
    // RULING P5-R15 ADDENDUM 3(3). One module held three things: the
    // dispatch-only VIEWER (4 fs sites), the per-agent canvas STATE (no fs), and
    // a file WATCHER whose callback fires from a polling timer — outside any
    // dispatch, for a path both tools and HTTP routes can set. Splitting three
    // ways is what makes each classification true of what the module does.
    const viewer = fs.readFileSync(path.join(SRC, 'agent/canvas-view.ts'), 'utf8');
    expect(/^import .*['"]node:fs['"]/m.test(viewer), 'the viewer must not hold node:fs').toBe(false);
    expect(viewer.includes('effectFs.'), 'it reads the canvas through the facade').toBe(true);
    const state = fs.readFileSync(path.join(SRC, 'agent/canvas-state.ts'), 'utf8');
    expect(/^import .*['"]node:fs['"]/m.test(state), 'the state surface touches no file at all').toBe(false);
    // The WATCH pair keeps `node:fs` and is named in the flip's excluded list with
    // its measured reason — dual-reached and platform-timed. It is two calls in
    // one small module rather than two calls inside a 300-line one, which is the
    // whole point of splitting three ways instead of two.
    const watch = fs.readFileSync(path.join(SRC, 'agent/canvas-watch.ts'), 'utf8');
    expect(/^import .*['"]node:fs['"]/m.test(watch), 'the watcher keeps its import, honestly').toBe(true);
    expect((watch.match(/fs\.(watchFile|unwatchFile)\(/g) ?? []).length, 'and holds exactly the watch pair').toBe(2);
    expect(watch.includes('effectFs.'), 'it does not pretend to be carried').toBe(false);
  });

  it('canvas_read DECLARES the canvas file it has always read', () => {
    // It declared `effects: []` and has always probed, stat-ed and read the file
    // on the agent's canvas. Same class as `open_browser` and `history_get`:
    // RULING P5-R14, corrected at the site, adding no refusal because gate rows
    // are declared in `tools/gates.ts` and never derived from `effects[]`.
    const shown = path.join(scratch, 'deck.pdf');
    const grants = grantsForCall(AGENT, effectsFor('canvas_read'), { prompt: 'x' }, {
      attachment_row: () => null, technique_dir: () => null, agent_canvas_file: () => ({ path: shown }),
    });
    expect(grantsCover(grants, { op: 'fs_read', path: shown, real: shown })).toBe(true);
    expect(grantsCover(grants, { op: 'fs_read', path: outOfScope, real: outOfScope })).toBe(false);
    expect(
      effectsFor('canvas_read')?.some((e) => e.scope?.at === 'agentResolved'),
      'canvas_read must declare the per-agent canvas it reads',
    ).toBe(true);
  });

  it('APPLICATION (c): the HANDLER\'S OWN PREDICATE decides whether an argument names a file at all', () => {
    // RULING P5-R15 ADDENDUM 3(1)(c). The office edit tools accept a local path
    // in EITHER `path` OR `file_id`, because models conflate the two — the
    // handler's own test is "does it start with / or ~". Declaring `file_id` as
    // an fs effect outright would mint a false grant for every genuine OneDrive
    // id; declaring nothing refuses a documented, live capability. The predicate
    // itself is the resolver, so a cloud id grants nothing and no false grant
    // can exist.
    const local = path.join(scratch, 'brief.docx');
    const decl: ToolEffect = { kind: 'fs_read', from: 'args.file_id', via: 'office_local_path' };
    const g1 = grantsForCall(AGENT, [decl], { file_id: local });
    expect(grantsCover(g1, { op: 'fs_read', path: local, real: local }), 'a path passed as file_id resolves').toBe(true);
    // A genuine OneDrive id is not a path and grants NOTHING — not the cwd
    // resolution of itself, not anything else.
    const cloud = '01ABCDEF23456789';
    const g2 = grantsForCall(AGENT, [decl], { file_id: cloud });
    expect(g2, 'a cloud id names no file').toEqual([]);
    expect(grantsForCall(AGENT, [decl], { file_id: 'relative/thing.docx' }), 'nor does a relative name').toEqual([]);
    expect(grantsForCall(AGENT, [decl], {}), 'nor an absent one').toEqual([]);
  });

  it('ONE RESOLUTION POINT: the office local-path predicate exists in exactly one place', () => {
    // The predicate was written TWICE in the same module (the Word edit resolver
    // and the Excel one), which is two chances for the gate loop's answer and the
    // handler's answer to drift apart. It is now one function both call, in a
    // leaf the gate loop can import without pulling ExcelJS, docx and the Graph
    // client into every dispatch's module graph.
    const leaf = fs.readFileSync(path.join(SRC, 'microsoft/office-local-path.ts'), 'utf8');
    expect(/^import .*['"]node:fs['"]/m.test(leaf), 'deciding whether a string is a path reads no file').toBe(false);
    expect(filesContaining('function localPathFromFileId('), 'the predicate has exactly one home')
      .toEqual(['microsoft/office-local-path.ts']);
    const door = fs.readFileSync(path.join(SRC, 'microsoft/tools-office.ts'), 'utf8');
    // No copy of the home expansion survives in the door — that was the tell of
    // the duplicate. (Its one remaining `startsWith('/')` is a zip-entry name
    // inside a .pptx, a different question entirely.)
    expect(door.includes("startsWith('~')"), 'the door expands no home path of its own').toBe(false);
    expect((door.match(/officeLocalPath\(args\)/g) ?? []).length, 'every local-target question goes through the one predicate').toBe(6);
  });

  it('CATEGORY CONVERTED: the office door reads and writes through the facade', () => {
    const src = fs.readFileSync(path.join(SRC, 'microsoft/tools-office.ts'), 'utf8');
    expect(/^import .*['"]node:fs['"]/m.test(src), 'the office door must not hold node:fs').toBe(false);
    expect(src.includes('effectFs.'), 'it reaches the disk through the facade').toBe(true);
  });

  it('every office edit tool authorizes the local file its call names, whichever argument named it', () => {
    const doc = path.join(scratch, 'report.docx');
    const READERS = ['office_get_word_document_outline', 'office_read_word_document', 'office_get_spreadsheet_range'];
    const WRITERS = ['office_append_to_word_document', 'office_replace_in_word_document',
      'office_insert_in_word_document', 'office_delete_block_in_word_document',
      'office_write_spreadsheet_range', 'office_append_spreadsheet_rows',
      'office_add_sheet', 'office_delete_sheet'];
    for (const tool of [...READERS, ...WRITERS]) {
      for (const args of [{ path: doc }, { file_id: doc }]) {
        const grants = grantsForCall(AGENT, effectsFor(tool), args);
        const named = 'path' in args ? 'path' : 'file_id';
        expect(grantsCover(grants, { op: 'fs_stat', path: doc, real: doc }), `${tool} may probe via ${named}`).toBe(true);
        expect(grantsCover(grants, { op: 'fs_read', path: doc, real: doc }), `${tool} may read via ${named}`).toBe(true);
        expect(grantsCover(grants, { op: 'fs_read', path: outOfScope, real: outOfScope }), `${tool} reaches nothing else`).toBe(false);
        const canWrite = WRITERS.includes(tool);
        expect(grantsCover(grants, { op: 'fs_write', path: doc, real: doc }), `${tool} write via ${named}`).toBe(canWrite);
      }
      // …and a genuine OneDrive id authorizes NO file at all.
      expect(grantsForCall(AGENT, effectsFor(tool), { file_id: '01ABCDEF23456789' }), `${tool} on a cloud id`).toEqual([]);
    }
  });

  it('the office create tools DECLARE the uploads dir they really write, never the bare filename', () => {
    // The same bare-name defect the PDF door carried: `filename` is a NAME the
    // handler sanitises before writing into `~/.dojo/uploads/<agentId>`. Resolved
    // as a path it named a file in the server's working directory these tools
    // never touch, while the real write went undeclared.
    const uploads = path.join(os.homedir(), '.dojo', 'uploads', AGENT);
    const out = path.join(uploads, 'Report.docx');
    for (const tool of ['office_create_word_document', 'office_create_spreadsheet', 'office_create_presentation']) {
      const grants = grantsForCall(AGENT, effectsFor(tool), { filename: 'Report.docx' });
      expect(grantsCover(grants, { op: 'fs_mkdir', path: uploads, real: uploads }), `${tool} may create its uploads dir`).toBe(true);
      expect(grantsCover(grants, { op: 'fs_write', path: out, real: out }), `${tool} may write its output`).toBe(true);
      const other = path.join(os.homedir(), '.dojo', 'uploads', 'someone-else', 'x.docx');
      expect(grantsCover(grants, { op: 'fs_write', path: other, real: other }), `${tool} may not write elsewhere`).toBe(false);
      const cwd = path.resolve('Report.docx');
      expect(grantsCover(grants, { op: 'fs_write', path: cwd, real: cwd }), `${tool} never names the bare filename`).toBe(false);
    }
    // …and office_create_word_document still reads the image blocks it embeds.
    const img = path.join(scratch, 'chart.png');
    const g = grantsForCall(AGENT, effectsFor('office_create_word_document'), {
      filename: 'Report.docx', content: [{ type: 'image', path: img }],
    });
    expect(grantsCover(g, { op: 'fs_read', path: img, real: img })).toBe(true);
  });

  it('CATEGORY CONVERTED: the slides door reads and writes through the facade', () => {
    const src = fs.readFileSync(path.join(SRC, 'google/tools-slides.ts'), 'utf8');
    expect(/^import .*['"]node:fs['"]/m.test(src), 'the slides door must not hold node:fs').toBe(false);
    expect(src.includes('effectFs.'), 'it reaches the disk through the facade').toBe(true);
  });

  it('THE STYLE STORE IS DECLARED PER VERB — a shared file every deck verb reads', () => {
    // ~20 `slides_*` verbs read the persisted deck style and 2 write it, and
    // every one of them declared `effects: []`. Converted as-is, the first read
    // would have been refused and every deck would have silently fallen back to
    // the default preset — a capability loss with no error anywhere. The store is
    // a FIXED path, so it needs no mechanic at all; what it needs is the
    // declaration on each verb that touches it.
    const store = path.join(os.homedir(), '.dojo', 'data', 'slides_styles.json');
    const READERS = ['slides_add_slide', 'slides_get_style', 'slides_add_text_box', 'slides_add_bullet_list',
      'slides_add_shape', 'slides_add_line', 'slides_populate_table', 'slides_layout_title',
      'slides_layout_section', 'slides_layout_content', 'slides_layout_two_column',
      'slides_layout_image', 'slides_layout_comparison', 'slides_build_slide'];
    const WRITERS = ['slides_create_presentation', 'slides_set_style'];
    for (const tool of [...READERS, ...WRITERS]) {
      const grants = grantsForCall(AGENT, effectsFor(tool), { presentation_id: 'deck-1' });
      expect(grantsCover(grants, { op: 'fs_read', path: store, real: store }), `${tool} may read the style store`).toBe(true);
      expect(grantsCover(grants, { op: 'fs_write', path: store, real: store }), `${tool} write`).toBe(WRITERS.includes(tool));
      // …and nothing else in the same directory, which is what makes it a path.
      const sibling = path.join(os.homedir(), '.dojo', 'data', 'dojo.db');
      expect(grantsCover(grants, { op: 'fs_read', path: sibling, real: sibling }), `${tool} reaches no sibling`).toBe(false);
    }
    // A verb that does NOT touch the store still declares nothing for it, which
    // is what keeps this a measurement rather than a blanket.
    const preset = grantsForCall(AGENT, effectsFor('slides_list_presets'), {});
    expect(grantsCover(preset, { op: 'fs_read', path: store, real: store }), 'slides_list_presets never reads it').toBe(false);
  });

  it('the style store writer owns its OWN temp-then-rename, kept separate from mechanic 6\'s', async () => {
    // RULING P5-R15 ADDENDUM mechanic 6's PRINCIPLE, applied to a DIFFERENT
    // mechanism: this writer names its temp `<target>.tmp` where `file_patch`'s
    // names it `.<base>.patch-<ts>-<rand>.tmp`, and it mkdir -p's the parent
    // first. It moved into the carrying layer WHOLE rather than being blended
    // into the existing entry — two mechanisms, two entries, no third spelling.
    const dir = path.join(scratch, 'store-dir');
    const target = path.join(dir, 'styles.json');
    await inCall([{ kind: 'fs_write', at: 'path', lexical: target, real: target }], 'slides_set_style', () => {
      effectFs.writeFileViaTmpSiblingSync(target, '{"deck":1}', 'utf-8');
    });
    expect(fs.readFileSync(target, 'utf8')).toBe('{"deck":1}');
    expect(fs.readdirSync(dir), 'no temp file survives a successful write').toEqual(['styles.json']);
    // The DECLARED resource is the TARGET; the temp sibling is never a second grant.
    await expect(
      inCall([], 'slides_set_style', () => { effectFs.writeFileViaTmpSiblingSync(target, 'x', 'utf-8'); }),
    ).rejects.toThrow(EffectNotAuthorized);
  });

  it('slides_export_pngs and slides_build_slide DECLARE what they really touch', () => {
    const uploads = path.join(os.homedir(), '.dojo', 'uploads', AGENT);
    const png = path.join(uploads, 'slide-1.png');
    const exportGrants = grantsForCall(AGENT, effectsFor('slides_export_pngs'), { presentation_id: 'deck-1' });
    expect(grantsCover(exportGrants, { op: 'fs_mkdir', path: uploads, real: uploads }), 'it may create its uploads dir').toBe(true);
    expect(grantsCover(exportGrants, { op: 'fs_write', path: png, real: png }), 'it may write each exported PNG').toBe(true);
    const other = path.join(os.homedir(), '.dojo', 'uploads', 'someone-else', 'x.png');
    expect(grantsCover(exportGrants, { op: 'fs_write', path: other, real: other }), 'never another agent uploads dir').toBe(false);
    // `slides_build_slide` uploads a LOCAL image named one level inside an
    // element (mechanic 7); a non-image element grants nothing for it.
    const img = path.join(scratch, 'logo.png');
    const buildGrants = grantsForCall(AGENT, effectsFor('slides_build_slide'), {
      presentation_id: 'deck-1',
      elements: [{ kind: 'text_box', text: 'hi' }, { kind: 'image_local', file_path: img }],
    });
    expect(grantsCover(buildGrants, { op: 'fs_read', path: img, real: img }), 'it may read the local image').toBe(true);
    expect(grantsCover(buildGrants, { op: 'fs_read', path: outOfScope, real: outOfScope }), 'and no other').toBe(false);
  });

  // ── THE TEMP-WORKSPACE CARRY — RULING P5-R15 ADDENDUM 4(1) ────────────────
  //
  // Mechanic 6's principle, one step wider. `atomicWriteFile` owns a temp
  // SIBLING of a declared target; this owns a temp PAIR in the platform's own
  // temp directory, which no declaration can name (`expandScopeTemplate`
  // expands `~`, `<agentId>` and `{args.<dotted>}`, and the platform temp
  // directory is none of the three). The mechanism moved into the carrying
  // layer WHOLE — same names, same order, same cleanup, errors rethrown
  // unchanged — and the temp files are the carry's own implementation detail,
  // never a second grant. The PROGRAM is what the call declares, and it rides
  // branch (B) as the first `CARRIED_PROGRAMS` member.

  /** A real 8 kHz mono 16-bit PCM WAV, built in memory, for ffmpeg to chew on. */
  function tinyWav(): Buffer {
    const samples = 800;
    const data = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(3000 * Math.sin(i / 8)), i * 2);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVEfmt ', 8, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);   // PCM
    header.writeUInt16LE(1, 22);   // mono
    header.writeUInt32LE(8000, 24);
    header.writeUInt32LE(8000 * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
  }

  const ffmpegGrant: ResourceGrant = { kind: 'proc', program: 'ffmpeg', display: 'ffmpeg' };
  const tmpWorkspaceFiles = (): string[] =>
    fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('dojo-stt-'));

  it('CATEGORY CONVERTED: the transcription service spawns nothing and holds no temp workspace', () => {
    const src = fs.readFileSync(path.join(SRC, 'services/transcription.ts'), 'utf8');
    expect(/^import .*['"]node:child_process['"]/m.test(src), 'it must not spawn').toBe(false);
    expect(/^import .*['"]node:fs['"]/m.test(src), 'and it must hold no filesystem of its own').toBe(false);
    expect(src.includes("from '../agent/effects/transcode.js'"), 'it transcodes through the carrying layer').toBe(true);
    // …and `child_process` still lives in exactly ONE facade module, which is
    // what keeps the streaming spawn from becoming a second door.
    expect(filesContaining("from 'node:child_process'", path.join(SRC, 'agent', 'effects')))
      .toEqual(['agent/effects/proc.ts']);
  });

  it('BRANCH (B): ffmpeg is a NAMED carried program, and a declaration cannot add another', () => {
    expect(Object.keys(CARRIED_PROGRAMS), 'the census list gained its first member').toContain('ffmpeg');
    expect(CARRIED_PROGRAMS['ffmpeg'].length, 'carried with a reason, never a bare name').toBeGreaterThan(20);
    // The generic census above already requires a reason per entry; this is the
    // other half — a program NOT on the list still grants nothing.
    const rogue = grantsForCall(
      AGENT,
      [{ kind: 'proc', from: 'derived:x', scope: { at: 'program', program: 'ffprobe' } } as ToolEffect],
      {},
    );
    expect(rogue).toEqual([]);
  });

  it('transcribe_audio DECLARES the program it spawns, and the grant is that program alone', () => {
    const grants = grantsForCall(AGENT, effectsFor('transcribe_audio'), { path: '/tmp/x.mp3' });
    expect(grantsCover(grants, { op: 'proc', program: 'ffmpeg' }), 'the declared transcoder').toBe(true);
    expect(grantsCover(grants, { op: 'proc', program: '/bin/sh' }), 'and nothing else').toBe(false);
    expect(grantsCover(grants, { op: 'proc', program: 'ffprobe' }), 'not even its sibling').toBe(false);
  });

  it('THE CARRY ASKS: with no authorization the transcode refuses, and leaves no workspace behind', async () => {
    const before = tmpWorkspaceFiles();
    await expect(decodeToWav16kMono(tinyWav(), '.wav')).rejects.toBeInstanceOf(EffectNotAuthorized);
    await expect(extractAudioFromVideo(tinyWav(), '.mp4')).rejects.toBeInstanceOf(EffectNotAuthorized);
    expect(tmpWorkspaceFiles(), 'the cleanup runs on the refusal path too').toEqual(before);
  });

  it('THE TEMP FILES ARE NEVER GRANTS: the program grant alone carries the whole workspace', async () => {
    // If the temp pair were routed through the facade this would refuse: the
    // call declares a program and nothing else, and no declaration in this
    // platform can name `os.tmpdir()`. It succeeds, end to end, on the real
    // transcoder — which is what makes the carry a carry rather than a rename.
    const before = tmpWorkspaceFiles();
    const out = await inCall([ffmpegGrant], 'transcribe_audio', () => decodeToWav16kMono(tinyWav(), '.wav'));
    expect(out.subarray(0, 4).toString('ascii'), 'a real RIFF came back').toBe('RIFF');
    expect(out.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(out.readUInt32LE(24), 'resampled to the 16 kHz the local engines want').toBe(16000);
    expect(out.readUInt16LE(22), 'and to mono').toBe(1);
    expect(tmpWorkspaceFiles(), 'both temp files are unlinked on the success path').toEqual(before);
  });

  it('…and the ERROR the caller sees is the one it always saw, rethrown unchanged', async () => {
    // Relocation purity: the caller's `catch` renders these strings into the
    // tool result the model reads, so the prose is part of the behaviour.
    await inCall([ffmpegGrant], 'transcribe_audio', async () => {
      await expect(decodeToWav16kMono(Buffer.from('not audio at all'), '.bin'))
        .rejects.toThrow(/^ffmpeg exited /);
      await expect(extractAudioFromVideo(Buffer.from('not a video at all'), '.bin'))
        .rejects.toThrow(/^ffmpeg video demux exited /);
    });
  });
});
