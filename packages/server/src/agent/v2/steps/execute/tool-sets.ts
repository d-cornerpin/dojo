// Hand-picked tool sets the execute step decides with; each is closed on purpose.

import { channelOfSendTool } from '@dojo/shared';
import { SEND_TO_PEOPLE } from '../../../sensei-policy.js';

// Every tool that sends something to a person, user_ twins included; the contact list, the call status and
// the hang-up stay in SEND_TO_PEOPLE for the grants and deny lists but are not sends.
export const SEND_TO_PEOPLE_SET: ReadonlySet<string> = new Set(SEND_TO_PEOPLE.filter((n) => channelOfSendTool(n) !== null));
// Async media generators delivered later by a background pipeline: the turn ends after one, bar the words
// step. Closed set tied to the delivery wiring; 'effectful-action' is far broader.
export const FIRE_AND_FORGET_GEN_TOOLS = new Set([
  'image_create',
  'tts_create',
  'music_create',
  'video_create',
]);
