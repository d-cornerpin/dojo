// ════════════════════════════════════════════════════════════════════════════════════════
// t277 - ISOLATE A CLAUSE BY CLEARING THE ENGINE'S SHARED STATE, NOT BY RELOADING THE PRODUCT.
//
// Many suites began every clause with `vi.resetModules()` so that `agent/shared-state.ts` (the
// stop fences, the run sets, the preempt cool-down, the abort registry...) would start empty. The
// price was the whole static import graph of whatever the clause then imported (`runtime.js`
// reaches ~650 modules) paid again INSIDE that clause's own timeout: ~1 s idle, 10-20 s on a
// loaded machine, and "Test timed out" whenever several suites ran at once.
//
// Every one of those facts is an exported `Map` or `Set` of the one module, and the module
// instance the code under test uses is the module instance this file imports (no registry reset
// separates them), so emptying them gives the clause the same blank slate for the price of a few
// `.clear()` calls. A heartbeat interval held in a map is cleared before its entry is dropped, so
// emptying the map cannot leak a live timer.
// ════════════════════════════════════════════════════════════════════════════════════════
import * as shared from '../shared-state.js';

export function clearEngineSharedState(): void {
  for (const value of Object.values(shared)) {
    if (value instanceof Map) {
      for (const entry of value.values()) {
        if (typeof entry === 'object' && entry !== null && 'unref' in entry) {
          clearInterval(entry as ReturnType<typeof setInterval>);
        }
      }
      value.clear();
    } else if (value instanceof Set) {
      value.clear();
    }
  }
}
