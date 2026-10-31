// Money is formatted in one place so a negative balance keeps its sign, a
// thousand keeps its comma, and a sub-cent spend isn't shown as zero.
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export const formatUsd = (v: number | null | undefined): string => {
  if (v === null || v === undefined || Number.isNaN(v) || v === 0) return '$0.00';
  if (v > 0 && v < 0.01) return '<$0.01';
  return usd.format(v);
};
