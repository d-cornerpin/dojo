import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from '../../../../../watchdog/src/alert-ledger.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = path.resolve(HERE, '../../../../../watchdog/src/index.ts');

describe('watchdog alert is not spent before it has anyone to go to', () => {
  it('a recipient-less claim returns false and leaves the ledger untouched', () => {
    const s = L.emptyState();
    expect((L as any).claimAlert(s, 'platform_down', '')).toBe(false);
    expect(s.alertState).toEqual({});
  });

  it('a later claim with a recipient is not blocked by the earlier empty one', () => {
    const s = L.emptyState();
    (L as any).claimAlert(s, 'platform_down', '');
    expect((L as any).claimAlert(s, 'platform_down', '+15550100')).toBe(true);
  });

  it('a second claim with a recipient inside the cooldown is suppressed', () => {
    const s = L.emptyState();
    const t0 = 1_000_000;
    expect((L as any).claimAlert(s, 'platform_down', '+15550100', t0)).toBe(true);
    expect((L as any).claimAlert(s, 'platform_down', '+15550100', t0 + 1000)).toBe(false);
  });

  it('after a recipient-less claim nothing is active, so no orphan recovery', () => {
    const s = L.emptyState();
    (L as any).claimAlert(s, 'platform_down', '');
    expect(L.markAlertResolved(s, 'platform_down')).toBe(false);
  });

  it('index.ts never calls the bare shouldSendAlert outside the wrapper', () => {
    const src = fs.readFileSync(INDEX_SRC, 'utf-8');
    const offenders = src.split('\n').filter((l) => /shouldSendAlert\(/.test(l) && !/^\s*(\/\/|\*)/.test(l) && !/function shouldSendAlert\(/.test(l) && !/shouldSendAlertIn\(/.test(l));
    expect(offenders).toEqual([]);
  });
});
