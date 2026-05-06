import { describe, it, expect } from 'vitest';
import {
  progressClassifier,
  buildSpinningNudge,
  PROGRESS_THRESHOLDS,
} from '../classifiers/progress.js';

const baseProgress = {
  toolCallsExecutedThisTurn: 5,
  consecutiveSmallDeltas: 0,
  consecutivePermissionDenials: 0,
  consecutiveNoResultTools: 0,
  spinningNudgeCount: 0,
  loopCount: 5,
};

describe('progressClassifier', () => {
  it('returns progressing for normal state', () => {
    const r = progressClassifier(baseProgress);
    expect(r.progressing).toBe(true);
  });

  it('detects small-delta spinning', () => {
    const r = progressClassifier({ ...baseProgress, consecutiveSmallDeltas: 3 });
    expect(r.progressing).toBe(false);
    if (!r.progressing) expect(r.signals.some((s) => s.includes('small-delta'))).toBe(true);
  });

  it('detects permission-denial spinning', () => {
    const r = progressClassifier({ ...baseProgress, consecutivePermissionDenials: 5 });
    expect(r.progressing).toBe(false);
    if (!r.progressing) expect(r.signals.some((s) => s.includes('permission denials'))).toBe(true);
  });

  it('detects no-result spinning', () => {
    const r = progressClassifier({ ...baseProgress, consecutiveNoResultTools: 3 });
    expect(r.progressing).toBe(false);
    if (!r.progressing) expect(r.signals.some((s) => s.includes('no-result'))).toBe(true);
  });

  it('combines multiple signals', () => {
    const r = progressClassifier({
      ...baseProgress,
      consecutiveSmallDeltas: 3,
      consecutivePermissionDenials: 5,
    });
    expect(r.progressing).toBe(false);
    if (!r.progressing) expect(r.signals.length).toBe(2);
  });

  it('hits the nudge cap when spinningNudgeCount maxed out', () => {
    const r = progressClassifier({
      ...baseProgress,
      spinningNudgeCount: PROGRESS_THRESHOLDS.MAX_SPINNING_NUDGES,
    });
    expect(r.progressing).toBe(false);
    if (!r.progressing) expect(r.reason).toContain('nudge cap');
  });

  it('thresholds match v1 expectations', () => {
    expect(PROGRESS_THRESHOLDS.PERMISSION_DENIAL_THRESHOLD).toBe(5);
    expect(PROGRESS_THRESHOLDS.MAX_SPINNING_NUDGES).toBe(3);
  });
});

describe('buildSpinningNudge', () => {
  it('includes turn count in the message', () => {
    const nudge = buildSpinningNudge({ ...baseProgress, loopCount: 42 });
    expect(nudge).toContain('42');
  });

  it('mentions complete_task with status=blocked', () => {
    const nudge = buildSpinningNudge(baseProgress);
    expect(nudge).toContain('complete_task');
    expect(nudge).toContain('blocked');
  });

  it('starts with [System: marker', () => {
    const nudge = buildSpinningNudge(baseProgress);
    expect(nudge.startsWith('[System:')).toBe(true);
  });
});
