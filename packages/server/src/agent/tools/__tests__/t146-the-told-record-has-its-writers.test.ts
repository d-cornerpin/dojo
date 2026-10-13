// ════════════════════════════════════════════════════════════════════════════════════════
// t146 — WIRE AND CENSUS CLAUSES, BOTH DIRECTIONS (G4), comments stripped before any source is
// read so a tombstone that names old code is never mistaken for the code.
//
//   §1 every send tool the dispatch door scopes carries the ONE optional `task_id` property,
//      and no other tool carries it;
//   §2 the told record's writers are exactly the two doors, each in a scope of its own;
//   §3 "who is the owner on iMessage" has one reader; the three old ones are gone.
// The behaviour itself is driven through the real doors in
// `services/__tests__/t146-a-raised-block-is-not-raised-again.test.ts`.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAllToolDefinitions } from '../definitions.js';
import { outboundChannelForTool } from '../../v2/outbound.js';
import { TOLD_ABOUT_TASK_ARG, TOLD_ABOUT_TASK_PROPERTY } from '../told-about-task.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const strip = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));
const production = (): Map<string, string> => {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'migrations') walk(fp); }
      else if (e.name.endsWith('.ts')) out.set(path.relative(SRC, fp).split(path.sep).join('/'), strip(fs.readFileSync(fp, 'utf8')));
    }
  };
  walk(SRC);
  return out;
};
const files = production();
const filesMatching = (re: RegExp): string[] => [...files].filter(([, s]) => re.test(s)).map(([f]) => f).sort();
const count = (file: string, re: RegExp): number => (files.get(file)!.match(new RegExp(re.source, 'g')) ?? []).length;
/** The body of `export function <name>(` up to its closing brace at column 0. */
const fnBody = (file: string, name: string): string => {
  const s = files.get(file)!;
  const i = s.indexOf(`export function ${name}(`);
  expect(i, `${name} in ${file}`).toBeGreaterThanOrEqual(0);
  return s.slice(i, s.indexOf('\n}\n', i));
};

describe('§1 the optional task_id is on exactly the send tools the dispatch door scopes', () => {
  const defs = getAllToolDefinitions();
  const props = (d: (typeof defs)[number]): Record<string, unknown> =>
    ((d.input_schema as { properties?: Record<string, unknown> }).properties ?? {});

  it('the argument is named task_id, as every other tool naming a work row names it', () => {
    expect(TOLD_ABOUT_TASK_ARG).toBe('task_id');
  });

  it('every scoped send tool carries the one property (by identity), and none requires it', () => {
    const sends = defs.filter((d) => outboundChannelForTool(d.name) !== null);
    expect(sends.length, 'the census is not vacuous').toBeGreaterThanOrEqual(11);
    const missing = sends.filter((d) => props(d)[TOLD_ABOUT_TASK_ARG] !== TOLD_ABOUT_TASK_PROPERTY).map((d) => d.name);
    expect(missing).toEqual([]);
    const requiring = sends.filter((d) => ((d.input_schema as { required?: string[] }).required ?? []).includes(TOLD_ABOUT_TASK_ARG));
    expect(requiring.map((d) => d.name), 'omitted must stay legal: omitted = no record').toEqual([]);
  });

  it('no tool the door does NOT scope carries the told property', () => {
    const strays = defs.filter((d) => outboundChannelForTool(d.name) === null && props(d)[TOLD_ABOUT_TASK_ARG] === TOLD_ABOUT_TASK_PROPERTY);
    expect(strays.map((d) => d.name)).toEqual([]);
  });
});

describe('§2 the told record is written by exactly the two doors, each in its own scope', () => {
  it('recordPersonTold is called in exactly the notice door and the dispatch door (plus its definition)', () => {
    expect(filesMatching(/\brecordPersonTold\s*\(/)).toEqual([
      'agent/tools/index.ts', 'services/imessage-bridge.ts', 'work/validation-drive.ts',
    ]);
    expect(count('agent/tools/index.ts', /\brecordPersonTold\s*\(/)).toBe(1);
    expect(count('services/imessage-bridge.ts', /\brecordPersonTold\s*\(/)).toBe(1);
    expect(count('work/validation-drive.ts', /\brecordPersonTold\s*\(/)).toBe(1);
  });

  it('the notice door writes it as owner_notice, from its OWN scope (withOutbound, never IfAbsent)', () => {
    const door = fnBody('services/imessage-bridge.ts', 'sendAlert');
    expect(door).toMatch(/withOutbound\(\s*\{\s*agentId: PLATFORM_SENDER/);
    expect(door).not.toMatch(/withOutboundIfAbsent/);
    // The text's scope tells from its own row; with no phone, the card's own scope does (round 2).
    expect(door).toMatch(/withOutbound\(\s*\{ agentId: PLATFORM_SENDER, tool: 'alert'[\s\S]*?toldAbout\(opts\.aboutWorkId, 'owner_notice'\)/);
    expect(door).toMatch(/if \(!sent && card === 'raised' && opts\.aboutWorkId && ownerCardStands\(scrubbed\)\)[\s\S]*?withOutbound\(\{ agentId: PLATFORM_SENDER, tool: 'owner-card', channel: 'dashboard', recipientId: 'owner' \}[\s\S]*?toldAbout\(workId, 'owner_card'\)/);
    const helper = files.get('services/imessage-bridge.ts')!;
    const h = helper.slice(helper.indexOf('function toldAbout('), helper.indexOf('\n}\n', helper.indexOf('function toldAbout(')));
    expect(h).toMatch(/const deliveryId = currentOutboundDeliveryId\(\);[\s\S]*recordPersonTold\(workId, \{ deliveryId, via \}\)/);
    expect(count('services/imessage-bridge.ts', /\btoldAbout\(/)).toBe(3);
  });

  it('the dispatch door writes it as send_tool, from the task_id ARGUMENT, inside withOutboundAsync', () => {
    const s = files.get('agent/tools/index.ts')!;
    const at = s.indexOf('recordPersonTold(');
    const scope = s.lastIndexOf('withOutboundAsync(intent', at);
    expect(scope, 'the record sits inside the scope this send opened').toBeGreaterThan(0);
    expect(s.slice(scope, at)).not.toMatch(/withOutboundAsyncIfAbsent/);
    expect(s.slice(scope, at + 120)).toMatch(/recordPersonTold\(task\.id, \{ deliveryId, via: 'send_tool' \}\)/);
    expect(s).toMatch(/\(resolved\.args as Record<string, unknown>\)\[TOLD_ABOUT_TASK_ARG\]/);
    expect(s).toMatch(/const task = resolveTaskId\(named\);/);
    expect(s, 'round 3 (M1): only a caller who may name the task records').toMatch(/task\.ok && agentMayNameTask\(agentId, task\.id\)/);
  });
});

describe('§3 one reader of "who is the owner on iMessage"', () => {
  it('the three old readers are gone and every caller reads the one rule', () => {
    expect(filesMatching(/\brecipientIsChannelOwner\b/)).toEqual([]);
    expect(filesMatching(/\bownerAddresses\b/)).toEqual([]);
    expect(fnBody('services/imessage-bridge.ts', 'getDefaultSender')).toMatch(/ownerIMessageRecord\(getSafeSenders\(\)\)/);
    // By file name (the refusal gate lives under the engine's step packages, which only the
    // shared corpus walks by path — guard-corpus-census).
    expect(filesMatching(/\bisOwnerIMessageRecipient\s*\(/).map((f) => f.slice(f.lastIndexOf('/') + 1)))
      .toEqual(['refusal-gates.ts', 'safe-senders.ts', 'validation-drive.ts']);
    expect(filesMatching(/\bownerIMessageRecord\s*\(/)).toEqual(['services/imessage-bridge.ts', 'services/safe-senders.ts']);
  });

  it('the legacy owner key is read in ONE module', () => {
    expect(filesMatching(/imessage_default_sender/)).toEqual(['services/safe-senders.ts']);
  });

  it('the safe-sender module stays importable by anything: it imports only the database, the logger and the recipient comparison', () => {
    const imports = [...files.get('services/safe-senders.ts')!.matchAll(/^import [^;]*? from '([^']+)';/gm)].map((m) => m[1]).sort();
    expect(imports).toEqual(['../agent/recipient-identity.js', '../db/connection.js', '../logger.js']);
  });
});
