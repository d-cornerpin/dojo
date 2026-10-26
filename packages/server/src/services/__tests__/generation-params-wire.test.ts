// ════════════════════════════════════════════════════════════════════════════
// WIRE HELPERS FOR AN AGENT'S VIDEO REQUEST
//
// generation-params.ts turns a validated canonical request into the body sent
// to a video model. Three pure helpers do the work and none was pinned:
//   composeSize        — folds aspect_ratio + resolution into one WIDTHxHEIGHT
//                        string (video providers take a single `size` field);
//   buildWireBody      — maps canonical fields to wire fields, coercing types and
//                        folding the two size parts into one;
//   defaultVideoSpecFor — picks a model family's accepted values from the registry.
//
// A wrong size string silently yields a wrong or rejected video, so these are
// pinned here as behaviour is on v35. They are pure: the module only touches the
// DB and logger inside functions these helpers do not call.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { composeSize, buildWireBody, defaultVideoSpecFor } from '../generation-params.js';

describe('composeSize — aspect + resolution fold into one WIDTHxHEIGHT', () => {
  it('maps the standard aspect/resolution pairs', () => {
    expect(composeSize('16:9', '720p'), '16:9 @ 720p is the landscape default').toBe('1280x720');
    expect(composeSize('16:9', '1080p'), '16:9 @ 1080p').toBe('1920x1080');
    expect(composeSize('16:9', '480p'), '16:9 @ 480p rounds the long side to 853').toBe('853x480');
    expect(composeSize('9:16', '1080p'), '9:16 @ 1080p is portrait').toBe('1080x1920');
    expect(composeSize('9:16', '720p'), '9:16 @ 720p is portrait').toBe('720x1280');
    expect(composeSize('1:1', '480p'), '1:1 keeps both sides equal').toBe('480x480');
  });

  it('falls back to 16:9 @ 720p on an unknown aspect', () => {
    expect(composeSize('4:3', '720p')).toBe('1280x720');
  });

  it('falls back to 720p on an unknown resolution', () => {
    expect(composeSize('16:9', 'weird')).toBe('1280x720');
  });
});

describe('buildWireBody — canonical fields map onto the provider body', () => {
  it('folds aspect + resolution into size and coerces duration to a number', () => {
    const spec = defaultVideoSpecFor('veo-3');
    const body = buildWireBody(spec, { duration: '8', aspect_ratio: '9:16', resolution: '1080p' });
    expect(body, 'duration is numeric, the two size parts fold into one size').toEqual({
      duration: 8,
      size: '1080x1920',
    });
  });

  it('emits no size when neither size part is given', () => {
    const spec = defaultVideoSpecFor('veo-3');
    const body = buildWireBody(spec, { duration: 4 });
    expect(body).toEqual({ duration: 4 });
  });

  it('defaults the missing resolution part to 720p when only aspect is given', () => {
    const spec = defaultVideoSpecFor('veo-3');
    const body = buildWireBody(spec, { aspect_ratio: '9:16' });
    expect(body).toEqual({ size: '720x1280' });
  });

  it('skips a field marked not accepted, but still composes size from the rest', () => {
    const spec = defaultVideoSpecFor('veo-3');
    spec.duration.accepted = false;
    const body = buildWireBody(spec, { duration: 8, aspect_ratio: '16:9', resolution: '720p' });
    expect(body, 'an unaccepted duration never reaches the body').toEqual({ size: '1280x720' });
  });
});

describe('defaultVideoSpecFor — family registry, case-insensitive, private copies', () => {
  it('resolves SeeDance case-insensitively to its resolution set', () => {
    expect(defaultVideoSpecFor('SeeDance-1').resolution.values).toEqual(['480p', '720p', '1080p']);
  });

  it('resolves veo to its duration set', () => {
    expect(defaultVideoSpecFor('veo-3').duration.values).toEqual([4, 6, 8]);
  });

  it('resolves any other family to the generic duration set', () => {
    expect(defaultVideoSpecFor('sora-2').duration.values).toEqual([4, 5, 6, 8, 10, 12]);
  });

  it('hands out a private copy so one caller cannot mutate the shared registry', () => {
    const first = defaultVideoSpecFor('veo-3');
    first.duration.values.push(99);
    const second = defaultVideoSpecFor('veo-3');
    expect(second.duration.values, 'a second call is unaffected by the first mutation').toEqual([4, 6, 8]);
  });
});
