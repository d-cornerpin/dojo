// ════════════════════════════════════════════════════════════════════════════════════════
// D15 — a system entry reading a per-turn field is a COMPILE ERROR. PHASE-3 T5 Step 1b.
//
// Research 06 requirement D15: "enforce structurally that target:'system' entries cannot
// read per-turn ctx fields (split the context type)". §4 named why it matters: the system
// prompt IS the cached prefix (roadmap #10), and one system render reading `ctx.turnContext`
// silently multiplies every agent's token cost while breaking NO test — the cache-prefix
// matrix samples nine turn-states, and a volatile field that happens to be constant across
// those nine sails straight through.
//
// A TYPE is only a guarantee if something proves it refuses. TypeScript erases, so a runtime
// assertion sees nothing, and a test that merely imports `SystemAssemblyContext` proves only
// that the name exists. So this compiles REAL fixtures with `tsc` and reads its verdict:
//
//   POSITIVE CONTROL  a system render reading a STABLE field must COMPILE. Without it, a
//                     narrowing that broke everything would look like a pass.
//   NEGATIVE CONTROL  a system render reading EACH volatile field must be REFUSED, with the
//                     field named in the error — generated from `VOLATILE_TURN_FIELDS`
//                     itself, so a field added to that list but not actually removed from
//                     the type fails here instead of silently widening the hole.
//   SIDE CONTROL      a MESSAGE render reading all of them must still compile, or the
//                     narrowing is not targeted, it is just breakage.
//
// ── ONE DETAIL THAT MATTERS FOR HONESTY ────────────────────────────────────────────────
// Compiling a fixture pulls in the modules it imports, and those carry pre-existing errors
// this project's own tsconfig settings do not produce (different lib/types). Asserting on
// tsc's exit code alone would therefore make the POSITIVE control fail for reasons that
// have nothing to do with D15 — and, worse, would make the NEGATIVE controls pass whether
// or not the narrowing works. Every assertion below is scoped to diagnostics naming the
// FIXTURE FILE, which is the only way this proof means what it says.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { VOLATILE_TURN_FIELDS } from '../types.js';

const SERVER = path.resolve(__dirname, '..', '..', '..', '..');   // packages/server
const TSC = path.resolve(SERVER, '..', '..', 'node_modules', '.bin', 'tsc');
const TYPES = path.join(SERVER, 'src/prompt/registry/types.js').replace(/\\/g, '/');

/** Compile one fixture and return ONLY the diagnostics that name the fixture itself. */
function fixtureErrors(body: string): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd15-'));
  const file = path.join(dir, 'fixture.ts');
  fs.writeFileSync(file, body, 'utf8');
  let out = '';
  try {
    execFileSync(TSC, [
      '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext',
      '--moduleResolution', 'NodeNext', '--skipLibCheck', file,
    ], { cwd: SERVER, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return out.split('\n').filter((l) => l.includes('fixture.ts('));
}

function systemFixture(reads: string[]): string {
  return `
import type { SystemInjection } from '${TYPES}';
import { SystemSlot } from '${TYPES}';

export const entry: SystemInjection = {
  id: 'sys.fixture',
  target: 'system',
  slot: SystemSlot.Identity,
  reason: 'a D15 fixture',
  render: (ctx) => [
${reads.map((r) => `    String(${r}),`).join('\n')}
  ].join(''),
};
`;
}

let positive: string[];
let negative: string[];
let messageSide: string[];

beforeAll(() => {
  // Three compiles, not eighteen: each volatile read sits on its own line in ONE negative
  // fixture, so tsc emits one diagnostic per field and the per-field clauses read them.
  positive = fixtureErrors(systemFixture(['ctx.agentId', 'ctx.modelId', 'ctx.isPM', 'ctx.ownerName']));
  negative = fixtureErrors(systemFixture(VOLATILE_TURN_FIELDS.map((f) => `ctx.${f}`)));
  messageSide = fixtureErrors(`
import type { MessageInjection } from '${TYPES}';
import { MessageSlot } from '${TYPES}';

export const entry: MessageInjection = {
  id: 'msg.fixture',
  target: 'messages',
  slot: MessageSlot.TurnContext,
  reason: 'a D15 fixture',
  render: (ctx) => ({
    role: 'user',
    content: [
${VOLATILE_TURN_FIELDS.map((f) => `      String(ctx.${f}),`).join('\n')}
    ].join(''),
  }),
};
`);
}, 120_000);

describe('D15 — target:"system" renders cannot see per-turn fields', () => {
  it('the volatile list is non-trivial and names what research 06 §4 named', () => {
    // A vacuity guard on everything below: a gutted list would make the negative fixture
    // read nothing and "pass" by not testing.
    expect(VOLATILE_TURN_FIELDS.length).toBeGreaterThanOrEqual(10);
    for (const named of ['turnContext', 'ttsEngine', 'loopCount', 'turnNumber', 'pendingNudge']) {
      expect(VOLATILE_TURN_FIELDS as readonly string[]).toContain(named);
    }
  });

  it('POSITIVE CONTROL: a system render reading STABLE fields still compiles', () => {
    expect(positive, `the narrowing broke a legitimate system render:\n${positive.join('\n')}`)
      .toEqual([]);
  });

  it.each([...VOLATILE_TURN_FIELDS])(
    'NEGATIVE CONTROL: ctx.%s is REFUSED inside a system render',
    (field) => {
      const named = negative.filter((l) => l.includes(`'${field}'`));
      expect(named, `tsc ACCEPTED a system render reading ctx.${field}`).not.toEqual([]);
      // and the refusal names the NARROWED type by name, so this cannot pass on some
      // unrelated typo in the fixture.
      expect(named.join('\n')).toMatch(/does not exist on type 'SystemAssemblyContext'/);
    },
  );

  it('every refusal is the NARROWING, not some unrelated error in the fixture', () => {
    expect(negative).toHaveLength(VOLATILE_TURN_FIELDS.length);
    for (const line of negative) expect(line).toMatch(/does not exist on type/);
  });

  it('SIDE CONTROL: a MESSAGE render may still read every one of them', () => {
    expect(messageSide, `the narrowing leaked onto the MESSAGE side:\n${messageSide.join('\n')}`)
      .toEqual([]);
  });
});
