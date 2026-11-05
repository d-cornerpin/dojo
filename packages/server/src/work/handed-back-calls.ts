// v3.5 field fix 3, re-review 4 N4: WHICH CALLS WERE HANDED TO THE BACKGROUND, BY CALL ID.
//
// When the exec door hands a call back (`agent/tools/person-first.ts` handedBack), the round's result
// for that call is the hand-back notice, not the command's result. The ledger must not read it as a
// clean exit. The hand-back marks the CALL here, by its id from the execution's own context
// (`agent/turn-state.ts` getCurrentToolCallId), with the command's final outcome; the ledger writer
// (`work/ledger-store.ts`) takes the mark for the call it is recording. Never matched on the words.
//
// A leaf: process memory only. A restart loses the marks, and the ledger row then stays "still
// running", which is honest (a restart ends the command; `background-commands.ts` tells the agent).

interface HandedBack { outcome: Promise<string>; final: string | null; at: number }

const handedBack = new Map<string, HandedBack>();
/** A mark nobody took (the call charged no task) is dropped after this long, once its command ended. */
const KEEP_SETTLED_MS = 60 * 60 * 1000;

function prune(now: number): void {
  for (const [id, h] of handedBack) if (h.final !== null && now - h.at > KEEP_SETTLED_MS) handedBack.delete(id);
}

/** The call `callId` was handed to the background; `outcome` is the command's final result. */
export function noteHandedBack(callId: string, outcome: Promise<string>): void {
  const now = Date.now();
  prune(now);
  // An outcome that rejects never reads as a clean exit: it is a failure with no reported status.
  const settled = outcome.catch(() => 'command_failed: ended without reporting a result');
  const h: HandedBack = { outcome: settled, final: null, at: now };
  handedBack.set(callId, h);
  void settled.then((text) => { h.final = text; h.at = Date.now(); });
}

/** Take the mark for `callId`, or null when the call was not handed back. Taken once. */
export function takeHandedBack(callId: string): { outcome: Promise<string>; final: string | null } | null {
  const h = handedBack.get(callId);
  if (!h) return null;
  handedBack.delete(callId);
  return { outcome: h.outcome, final: h.final };
}
