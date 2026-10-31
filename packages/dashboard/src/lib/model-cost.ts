// Price-per-million-tokens label shown on model browse rows (Settings and the setup wizard).
export const formatCost = (cost: number | null): string => {
  if (cost === null || cost === 0) return 'Free';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
};
