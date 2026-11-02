// `grants.tools.add` appends named tools to an allow list: it never drops a held name, never narrows an unrestricted
// list, and is judged for escalation exactly as `allow` is. (`allow` still replaces the whole list.)
import { describe, it, expect } from 'vitest';
import { MOST_RESTRICTIVE_GRANTS, cloneGrants } from '@dojo/shared';
import { validateGrants, grantExcesses, mergeGrants, resolveUpdateGrants } from '../authorize.js';

const withAllow = (allow: string[], deny: string[] = []) => { const g = cloneGrants(MOST_RESTRICTIVE_GRANTS); g.tools.allow = allow; g.tools.deny = deny; return g; };

describe('grants.tools.add', () => {
  it('is accepted by the schema', () => {
    expect(validateGrants({ tools: { add: ['a'] } }).ok).toBe(true);
  });

  it('appends, keeps every held name in order, and does not duplicate (aliases count as held)', () => {
    const base = withAllow(['x', 'tracker_get_status', 'y']);
    const out = mergeGrants(base, { tools: { add: ['z', 'x', 'work_update', 'w'] } });
    expect(out.tools.allow).toEqual(['x', 'tracker_get_status', 'y', 'z', 'w']);
  });

  it('never widens an unrestricted (empty) list', () => {
    expect(mergeGrants(withAllow([]), { tools: { add: ['z'] } }).tools.allow).toEqual([]);
  });

  it('never touches deny; a denied name stays denied', () => {
    const out = mergeGrants(withAllow(['x'], ['z']), { tools: { add: ['z'] } });
    expect(out.tools.deny).toEqual(['z']);
  });

  it('allow still replaces the whole list', () => {
    expect(mergeGrants(withAllow(['x', 'y']), { tools: { allow: ['q'] } }).tools.allow).toEqual(['q']);
  });

  it('a caller cannot add what it does not hold', () => {
    const out = grantExcesses({ tools: { add: ['a', 'secret'] } }, withAllow(['a', 'b']), false);
    expect(out.join(' ')).toContain('"secret"');
    expect(grantExcesses({ tools: { add: ['a'] } }, withAllow(['a', 'b']), false)).toEqual([]);
    expect(grantExcesses({ tools: { add: ['anything'] } }, withAllow([]), false)).toEqual([]);   // an unrestricted caller holds all
  });

  it('through the edit door: refused when beyond the granter, appended when within', () => {
    const target = withAllow(['x']);
    expect(resolveUpdateGrants({ tools: { add: ['secret'] } }, target, withAllow(['x', 'a']), false).ok).toBe(false);
    const r = resolveUpdateGrants({ tools: { add: ['a'] } }, target, withAllow(['x', 'a']), false);
    expect(r.ok && r.grants.tools.allow).toEqual(['x', 'a']);
  });
});
