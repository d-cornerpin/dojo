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
import { scrubTechnicalDetail } from '../agent/v2/error-format.js';

/** `PLATFORM_SENDER` (agent/v2/outbound.ts), spelled here so this module stays a leaf: the one
 *  status writer imports it, and outbound's graph reaches the work spine. Pinned equal by the
 *  t138 round-2 suite (`PLATFORM_SENDER` is 'platform') and read by the dashboard. */
const PLATFORM_SENDER = 'platform';

export function ownerCardFrame(words: string, severity: 'error' | 'warning' | 'info'): void {
  try {
    broadcast({ type: 'chat:error', agentId: PLATFORM_SENDER, error: scrubTechnicalDetail(words), severity, retryable: false });
  } catch { /* a card is best-effort; the text and the state are what matter */ }
}

/** A condition ended: its card leaves every open dashboard. */
export function ownerCardEnded(words: string): void {
  ownerCardFrame(words, 'info');
}

// ── LASTING CARDS (t146 round 3) ──
// A card is a live frame: with no dashboard open it is lost. The cards that LAST are the ones the
// owner-notices list re-derives from state (`gateway/routes/config.ts`), so he sees them on his
// next dashboard load. The route registers that list here (this module stays a leaf), and the
// owner-notice door asks it before counting a card as the owner told about a work row.
let standingCards: (() => ReadonlyArray<{ words: string }>) | null = null;

export function registerStandingOwnerCards(source: () => ReadonlyArray<{ words: string }>): void {
  standingCards = source;
}

/** Would the owner-notices list show a card in these words right now? Unknown means no. */
export function ownerCardStands(words: string): boolean {
  try {
    const want = scrubTechnicalDetail(words);
    return standingCards !== null && standingCards().some((c) => scrubTechnicalDetail(c.words) === want);
  } catch {
    return false;
  }
}
