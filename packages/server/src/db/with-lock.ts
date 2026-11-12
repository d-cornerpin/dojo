// Per-key mutex: wait for the key, or skip when held. In-process only (a promise chain), not cross-process.

const chains = new Map<string, Promise<unknown>>();

export async function withLock<T>(key: string, fn: () => Promise<T>,
  opts: { ifBusy?: 'wait' | 'skip' } = {}): Promise<T | undefined> {
  if (opts.ifBusy === 'skip' && chains.has(key)) return undefined;
  const prev = chains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  // The map holds `mine`, so the finally deletes the key only when nobody queued behind this call.
  const mine = prev.then(() => gate);
  chains.set(key, mine);
  await prev;
  try { return await fn(); }
  finally { release(); if (chains.get(key) === mine) chains.delete(key); }
}

export async function whenLockFree(key: string): Promise<void> {
  for (let held = chains.get(key); held; held = chains.get(key)) await held.catch(() => undefined);
}
