// Known agent + WHOLE content-free pleasantry: persist the row, take no turn, so the
// iMessage courtesy volley cannot self-sustain. A human's "thanks!" is never damped.
// Matchers are whole-message and lean never-fires: a missed turn costs more than a
// dampened courtesy. (b) an inbound that IS an engine ack line is machine courtesy.

import {
  START_ACK_POOL,
  PROGRESS_ACK_POOL,
  A2A_HANDOFF_ACK_POOL,
  COMPLETION_ACK_POOL,
} from '../ack-copy.js';

const ACK_POOL_STRINGS: ReadonlySet<string> = new Set<string>([
  ...START_ACK_POOL,
  ...PROGRESS_ACK_POOL,
  ...A2A_HANDOFF_ACK_POOL,
  ...COMPLETION_ACK_POOL,
]);

const PLEASANTRY_PHRASE =
  '(?:talk soon|talk later|talk to you soon|chat soon|catch you later|catch you soon|' +
  'sounds good|sounds great|sounds like a plan|sound good|works for me|good deal|' +
  'thanks|thanks so much|thanks again|thank you|thank you so much|much appreciated|appreciate it|' +
  'you too|same to you|likewise|' +
  'have a good one|have a good night|have a good day|have a good evening|have a great day|have a nice day|' +
  'no rush|no worries|no problem|not a problem|all good|all set|' +
  'sure thing|will do|take care|see you|see ya|cheers)';

const PLEASANTRY_WHOLE_RE = new RegExp(
  `^[\\s\`*_>-]*${PLEASANTRY_PHRASE}(?:[.!,\\s]+(?:and\\s+)?${PLEASANTRY_PHRASE})*[.!\\s\`*_]*$`,
  'i',
);

// Cap guards (a) only; (b) runs any length, those ack lines are long.
const PLEASANTRY_MAX_CHARS = 48;

export const isEngineAckLine = (text: string): boolean => ACK_POOL_STRINGS.has((text ?? '').trim());

export function isContentFreeCourtesy(text: string): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length === 0) return false;
  if (isEngineAckLine(t)) return true;
  if (t.length > PLEASANTRY_MAX_CHARS) return false;
  return PLEASANTRY_WHOLE_RE.test(t);
}
