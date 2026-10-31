import { describe, it, expect } from 'vitest';
import { resolveToolAlias } from '../aliases.js';
import { composePrimarySoul } from '../../prompt/oobe-soul.js';
import { renderIndexName } from '../index-notes.js';

describe('table lookups ignore inherited object names', () => {
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])('resolveToolAlias(%s) is no alias', (n) => {
    const r = resolveToolAlias(n, {});
    expect(r).toEqual({ name: n, args: {} });
    expect(r.note).toBeUndefined();
  });

  it.each(['constructor', 'toString', '__proto__'])('composePrimarySoul treats style %s as the default', (style) => {
    const soul = composePrimarySoul({ communicationStyle: style } as never);
    expect(soul).toBe(composePrimarySoul({ communicationStyle: 'balanced' } as never));
    expect(soul).not.toContain('native code');
  });

  it.each(['toString', 'constructor', '__proto__'])('renderIndexName(%s) has no note', (n) => {
    expect(renderIndexName(n)).toBe(`\`${n}\``);
  });
});
