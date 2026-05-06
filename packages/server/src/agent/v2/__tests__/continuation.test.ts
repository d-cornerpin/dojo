import { describe, it, expect } from 'vitest';
import {
  continuationClassifier,
  CONTINUATION_DEFAULTS,
} from '../classifiers/continuation.js';

const baseProgress = {
  toolCallsExecutedThisTurn: 75,
  consecutiveSmallDeltas: 0,
  consecutivePermissionDenials: 0,
  consecutiveNoResultTools: 0,
  spinningNudgeCount: 0,
  loopCount: 75,
};

const baseInput = {
  loopCount: 30,
  loopCapSoft: CONTINUATION_DEFAULTS.LOOP_CAP_SOFT,
  continuationCount: 0,
  continuationCapHard: CONTINUATION_DEFAULTS.CONTINUATION_CAP_HARD,
  progress: baseProgress,
};

describe('continuationClassifier', () => {
  it('continues below the soft loop cap', () => {
    const r = continuationClassifier({ ...baseInput, loopCount: 30 });
    expect(r.decision).toBe('continue');
  });

  it('stops when continuation cap reached', () => {
    const r = continuationClassifier({ ...baseInput, continuationCount: 3 });
    expect(r.decision).toBe('stop');
    if (r.decision === 'stop') expect(r.reason).toContain('continuation cap');
  });

  it('continues at soft cap when progressing', () => {
    const r = continuationClassifier({
      ...baseInput,
      loopCount: 75,
      progress: baseProgress,  // no spinning signals
    });
    expect(r.decision).toBe('continue');
  });

  it('stops at soft cap when spinning', () => {
    const r = continuationClassifier({
      ...baseInput,
      loopCount: 75,
      progress: { ...baseProgress, consecutivePermissionDenials: 5 },
    });
    expect(r.decision).toBe('stop');
  });

  it('defaults match v1', () => {
    expect(CONTINUATION_DEFAULTS.LOOP_CAP_SOFT).toBe(75);
    expect(CONTINUATION_DEFAULTS.CONTINUATION_CAP_HARD).toBe(3);
  });
});
