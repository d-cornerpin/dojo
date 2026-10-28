import { it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
it.each(['components/CostCharts.tsx', 'lib/theme.ts'])('%s is gone', (rel) => {
  expect(existsSync(resolve(__dirname, '..', rel))).toBe(false);
});
