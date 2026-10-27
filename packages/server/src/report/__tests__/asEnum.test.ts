// asEnum — the enum coercer: a declared member comes back as itself, a null source
// comes back ABSENT, and everything else fails closed to UNRECOGNISED.
import { describe, it, expect } from 'vitest';
import { asEnum } from '../telemetry-coerce.js';

describe('a declared member comes back as itself', () => {
  const MEMBERS: [string, string][] = [
    ['report.lane', 'tool-error'],
    ['report.lane', 'wrong-answer'],
    ['platform.os', 'darwin'],
    ['platform.os', 'win32'],
    ['turn.kind', 'user'],
    ['turn.kind', 'none'],
    ['tool.action_type', 'tool_call'],
    ['tool.arg_shape.type', 'string'],
  ];
  for (const [path, member] of MEMBERS) {
    it(`${path} admits ${member}`, () => {
      expect(asEnum(path, member)).toBe(member);
    });
  }
});

describe('an off-domain value, an empty string and a non-enum field fail closed', () => {
  // An empty string is a member of no field, so it is UNRECOGNISED, not ABSENT.
  // A path whose kind is not 'enum' (the 'count' field node_major) is UNRECOGNISED
  // even for a plausible-looking value.
  const CASES: [string, string][] = [
    ['report.lane', 'nonsense'],
    ['report.lane', ''],
    ['platform.os', 'windows'],
    ['no.such.field', 'x'],
    ['platform.node_major', 'x'],
  ];
  for (const [path, value] of CASES) {
    it(`${path} = ${JSON.stringify(value)} is unrecognised`, () => {
      expect(asEnum(path, value)).toBe('<unrecognised>');
    });
  }
});

describe('a null or undefined source is ABSENT, not UNRECOGNISED', () => {
  it('report.lane = null is absent', () => {
    expect(asEnum('report.lane', null)).toBe('<absent>');
  });
  it('report.lane = undefined is absent', () => {
    expect(asEnum('report.lane', undefined)).toBe('<absent>');
  });
  it('turn.kind = null is absent', () => {
    expect(asEnum('turn.kind', null)).toBe('<absent>');
  });
});
