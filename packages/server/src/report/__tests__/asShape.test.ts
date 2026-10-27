import { describe, it, expect } from 'vitest';
import { asShape } from '../telemetry-coerce.js';

// The per-field coercer: a value passes through only when it matches its field's own
// anchored pattern; null/undefined reads ABSENT; a field that declares no pattern
// (the enum report.lane, the numeric window.minutes) admits nothing and reads UNRECOGNISED.
const UNRECOGNISED = '<unrecognised>';
const ABSENT = '<absent>';

const CASES: [string, string | null | undefined, string][] = [
  ['report.schema', 'dojo-telemetry-1', 'dojo-telemetry-1'],
  ['report.schema', 'dojo-telemetry-2', UNRECOGNISED],
  ['report.schema', '', UNRECOGNISED],
  ['report.schema', null, ABSENT],
  ['report.schema', undefined, ABSENT],
  ['platform.version', '1.2.3', '1.2.3'],
  ['platform.version', '1.2.3-rc1', '1.2.3-rc1'],
  ['platform.version', '1.2.3-beta.1.2', '1.2.3-beta.1.2'],
  ['platform.version', '1.2.3-', UNRECOGNISED],
  ['platform.version', '1.2', UNRECOGNISED],
  ['report.signature', 'ds1-123456789abc', 'ds1-123456789abc'],
  ['report.signature', 'ds2-0123456789ab', 'ds2-0123456789ab'],
  ['report.signature', 'taxes.pdf', UNRECOGNISED],
  ['report.lane', 'tool-error', UNRECOGNISED],
  ['window.minutes', '5', UNRECOGNISED],
];

describe('asShape', () => {
  for (const [path, value, out] of CASES) {
    it(`${path} / ${JSON.stringify(value)} -> ${out}`, () => {
      expect(asShape(path, value)).toBe(out);
    });
  }
});
