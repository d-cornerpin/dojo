// The words of a delegated answer coming back: the order handed to the turn serving the request, and the one
// line the Dojo puts in front of the pieces when it relays them itself.

import type { CompileAsker } from './compile-asker.js';
import type { PutBackKind } from './ask-settlement.js';

/** The one line the engine composes for the relay; the helpers' delivered text follows whole, since summarising
 *  is the model's job. The wording varies only so the sentence stays true for the number of pieces. */
export function engineRelayPreface(total: number): string {
  if (total === 1) return "The helper's answer, as it was delivered:";
  const quantifier = total === 2 ? 'Both' : `All ${total}`;
  return `${quantifier} results are in as the helpers delivered them; they were `
    + `not combined, so here they are in full:`;
}

/** The order: an opening by kind counting only what came back, what the owner called off, the person's request
 *  whole, the files, and every piece whole. The engine counts structure and never judges the pieces. */
export function compileSteerText(p: {
  kind: PutBackKind; asker: CompileAsker | null; helper: string; request: string; files: string[]; pieces: string[]; back: number; calledOff: string[];
}): string {
  const whose = p.asker ? `${p.asker.name}'s` : "the owner's";
  const who = p.asker ? `${p.asker.name}${p.asker.channel ? ` (by ${p.asker.channel})` : ''}` : 'the owner';
  const opening = p.kind === 'late'
    ? `${p.helper} answered your earlier delegation after all; ${who} was told there was no answer yet, so start your reply with "Update:".`
    : p.kind === 'update'
      ? `${p.helper} corrected its work after review; ${who} already had the earlier answer, so start your reply with "Update:" and say what changed.`
      : p.back < p.pieces.length
        ? `${p.back} of ${p.pieces.length} delegated pieces for ${whose} request came back.`
        : p.pieces.length === 1 ? `The delegated piece for ${whose} request is back.` : `All ${p.pieces.length} delegated pieces for ${whose} request are back.`;
  const off = p.calledOff.length > 0 ? `\nThe owner called off: ${p.calledOff.join(', ')}; leave them out of the answer.` : '';
  const files = p.files.length > 0
    ? `\nFiles the helpers sent back: ${p.files.join(', ')}. To pass on a long answer, attach its file with share_file instead of retyping it.`
    : '';
  return `${opening}${off}\nThey asked: "${p.request}"${files}\n\n${p.pieces.join('\n')}`;
}
