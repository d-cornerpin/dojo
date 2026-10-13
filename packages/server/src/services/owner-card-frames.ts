// ════════════════════════════════════════════════════════════════════════════════════════
// THE ONE FRAME PATH FOR THE OWNER'S DASHBOARD CARDS (t138 rounds 2-4).
//
// Every text the platform sends the owner also waits on his dashboard as a card, carried by the
// existing `chat:error` notification spoken by `PLATFORM_SENDER`. Two frames, one shape:
//   - a card: severity `error` (critical) or `warning` (notice), in the words of the text;
//   - an END: severity `info`, naming the card that leaves — sent by an all-clear text, and by
//     the server itself whenever it records a condition clearing (a top-up, an agent resumed,
//     a sign-in restored, the Healer back, memory recovered, a budget's spend dropping), so a
//     card leaves every open dashboard when its condition ends, not only on the next load.
// The dashboard (`GlobalAlerts`) shows the first and removes on the second; on load it asks
// `GET /api/config/owner-notices`, which re-derives the cards still standing.
// ════════════════════════════════════════════════════════════════════════════════════════

import { broadcast } from '../gateway/ws.js';
import { PLATFORM_SENDER } from '../agent/v2/outbound.js';
import { scrubTechnicalDetail } from '../agent/v2/error-format.js';

export function ownerCardFrame(words: string, severity: 'error' | 'warning' | 'info'): void {
  try {
    broadcast({ type: 'chat:error', agentId: PLATFORM_SENDER, error: scrubTechnicalDetail(words), severity, retryable: false });
  } catch { /* a card is best-effort; the text and the state are what matter */ }
}

/** A condition ended: its card leaves every open dashboard. */
export function ownerCardEnded(words: string): void {
  ownerCardFrame(words, 'info');
}
