// ════════════════════════════════════════════════════════════════════════════
// THE ONE SHARED FIXTURE VOCABULARY (v3.5): the only place a test gets an invented person / agent name from.
//
// WHY: the stand-in names the tests use are COINED words, registered in `fixture-names.json`. A coined word is collision-resistant, not
// collision-proof: an owner may one day name a real agent after one. When every test file spelled the word out, that collision was a
// 190-file event. Now no test spells a stand-in out. A test imports a SLOT from here and the slot is filled from the registry's `standIns`
// list, in order, so a collision is a one-line edit to `fixture-names.json` (`rename-fixture-name.mjs` does it) and no test file changes.
//
//   import { FX, FXID, FXUP } from '<up to>/deploy/checks/fixture-vocabulary.mjs';
//   FX.n4     the display form    (as the registry spells it, e.g. 'Capitalised')
//   FXID.n4   the lowercase form  (ids, slugs, file names)
//   FXUP.n4   the UPPERCASE form
//
// A slot is a position, never a word: n1 is the first registered stand-in, n2 the second. Read an unknown slot and it throws, so a typo
// or a registry that shrank fails loudly instead of putting the string "undefined" into a fixture.
// `a-test-never-spells-a-stand-in.test.ts` (server) holds the line: no test file may carry a registered stand-in as a literal.
// ════════════════════════════════════════════════════════════════════════════
import { loadRegistry } from './fixture-names.mjs';

const standIns = loadRegistry().standIns;

function table(fn) {
  const t = Object.fromEntries(standIns.map((w, i) => [`n${i + 1}`, fn(w)]));
  return new Proxy(Object.freeze(t), {
    get(target, key) {
      if (typeof key === 'symbol' || key in target) return Reflect.get(target, key);
      throw new Error(`fixture-vocabulary: there is no slot "${String(key)}" (the registry has n1..n${standIns.length})`);
    },
  });
}

export const FX = table((w) => w);
export const FXID = table((w) => w.toLowerCase());
export const FXUP = table((w) => w.toUpperCase());
export const SLOT_COUNT = standIns.length;
