// ════════════════════════════════════════════════════════════════════════════════════════
// child-failure's two OTHER readers, beside childFailureText.
//
// `t219-update-error-words.test.ts` names only `childFailureText`. The other two readers the
// update path leans on had no test of their own, and a wrong answer at their two sites turns a
// full disk into a generic failure, or the reverse:
//   - `childFailureEvidence(err)` — everything a failed child printed, for recognising a cause;
//                                    read at `disk-preflight.ts` (`isOutOfSpaceError`) and, through
//                                    `isUnnamedWriteFailure`, at `gateway/routes/update.ts`.
//   - `isUnnamedWriteFailure(err)` — curl's exit 23, "a write failure that does not name its
//                                    cause"; only the kind of failure a short volume confirms.
//
// Pure: each input is the real shape the reader sees, and each expected output is what the
// function prints on v35. No stand-ins, no mocks.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';

describe('childFailureEvidence joins the parts a child printed, trimmed, in order', () => {
  it('message, stderr and stdout are each trimmed and joined by a newline', async () => {
    const { childFailureEvidence } = await import('../child-failure.js');
    expect(childFailureEvidence({ message: ' boom ', stderr: 'err line\n', stdout: ' out ' }))
      .toBe('boom\nerr line\nout');
  });

  it('a child that printed nothing at all is an empty string', async () => {
    const { childFailureEvidence } = await import('../child-failure.js');
    expect(childFailureEvidence({ stderr: '', stdout: '' })).toBe('');
  });

  it('blank parts are dropped, the rest still joined', async () => {
    const { childFailureEvidence } = await import('../child-failure.js');
    expect(childFailureEvidence({ message: 'm', stderr: '  ', stdout: 'o' })).toBe('m\no');
  });

  it('a string and an Error read as their own text, never an object', async () => {
    const { childFailureEvidence } = await import('../child-failure.js');
    expect(childFailureEvidence('plain')).toBe('plain');
    expect(childFailureEvidence(new Error('x'))).toBe('x');
  });

  it('nothing at all is "failed with no explanation"', async () => {
    const { childFailureEvidence } = await import('../child-failure.js');
    expect(childFailureEvidence(null)).toBe('failed with no explanation');
    expect(childFailureEvidence(undefined)).toBe('failed with no explanation');
  });
});

describe('isUnnamedWriteFailure names curl\'s exit 23, and nothing that only looks like it', () => {
  it('is true for an exit 23 and for its words on the message, stderr or stdout', async () => {
    const { isUnnamedWriteFailure } = await import('../child-failure.js');
    expect(isUnnamedWriteFailure({ code: 23 })).toBe(true);
    expect(isUnnamedWriteFailure(new Error('curl: (23) Failure writing output to destination')))
      .toBe(true);
    expect(isUnnamedWriteFailure({ stderr: 'curl: (23) Failure writing' })).toBe(true);
    // case-insensitive: the word "Failure" matched in lower case
    expect(isUnnamedWriteFailure({ stdout: 'failure writing output to destination' })).toBe(true);
    expect(isUnnamedWriteFailure('curl: (23) x')).toBe(true);
  });

  it('is false for the look-alikes that are not an exit 23', async () => {
    const { isUnnamedWriteFailure } = await import('../child-failure.js');
    expect(isUnnamedWriteFailure({ code: '23' })).toBe(false);   // a string code is not the number 23
    expect(isUnnamedWriteFailure('23')).toBe(false);
    expect(isUnnamedWriteFailure(null)).toBe(false);
    expect(isUnnamedWriteFailure(undefined)).toBe(false);
    expect(isUnnamedWriteFailure({})).toBe(false);
    expect(isUnnamedWriteFailure({ code: 7, stderr: 'curl: (6) Could not resolve host' })).toBe(false);
  });
});
