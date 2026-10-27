// THE LATEST TOLD-AT: the newest of a budget row's three alert latches, each null read as 0.
import { describe, it, expect } from 'vitest';
import { latestToldAt } from '../budget-cards.js';

describe('latestToldAt', () => {
  it('reads the only non-null latch', () => {
    expect(latestToldAt({ alert_50_sent: 5, alert_75_sent: null, alert_90_sent: null })).toBe(5);
    expect(latestToldAt({ alert_50_sent: null, alert_75_sent: 12, alert_90_sent: null })).toBe(12);
    expect(latestToldAt({ alert_50_sent: null, alert_75_sent: null, alert_90_sent: 30 })).toBe(30);
  });

  it('returns the newest of the three latches', () => {
    expect(latestToldAt({ alert_50_sent: 100, alert_75_sent: 200, alert_90_sent: 300 })).toBe(300);
    expect(latestToldAt({ alert_50_sent: 300, alert_75_sent: 200, alert_90_sent: 100 })).toBe(300);
  });

  it('reads null as 0', () => {
    expect(latestToldAt({ alert_50_sent: null, alert_75_sent: null, alert_90_sent: null })).toBe(0);
  });

  it('keeps a stored 0', () => {
    expect(latestToldAt({ alert_50_sent: 0, alert_75_sent: 0, alert_90_sent: 0 })).toBe(0);
  });

  it('a negative latch loses to a larger one', () => {
    expect(latestToldAt({ alert_50_sent: -5, alert_75_sent: 5, alert_90_sent: 10 })).toBe(10);
  });

  it('equal latches give that value', () => {
    expect(latestToldAt({ alert_50_sent: 50, alert_75_sent: 50, alert_90_sent: 50 })).toBe(50);
  });
});
