// The Dojo asks macOS's `caffeinate` to hold the Mac awake on power for as long as the server's own
// process lives; on a machine without `caffeinate` it asks for nothing. Nothing is spawned here.
import { describe, it, expect } from 'vitest';
import { keepMacAwake } from '../keep-awake.js';

type Call = { bin: string; args: string[] };
function recorder(calls: Call[]) {
  return ((bin: string, args: string[]) => {
    calls.push({ bin, args });
    return { on: () => ({ unref: () => undefined }) };
  }) as unknown as Parameters<typeof keepMacAwake>[0];
}

describe('the Dojo keeps the Mac awake only while it runs', () => {
  it('asks caffeinate to hold the Mac awake on power until the server process ends', () => {
    const calls: Call[] = [];
    keepMacAwake(recorder(calls), process.execPath);
    expect(calls).toEqual([{ bin: process.execPath, args: ['-s', '-w', String(process.pid)] }]);
  });

  it('asks for nothing where caffeinate is missing', () => {
    const calls: Call[] = [];
    keepMacAwake(recorder(calls), '/nonexistent/caffeinate');
    expect(calls).toEqual([]);
  });
});
