// ════════════════════════════════════════════════════════════════════════════
// THE ENGINE'S OWN CHANNEL DOOR (UX-ACCESS A4) — A1 §6.2, closed.
//
// A1, A2 and A3 each recorded the same hand-up and each declined it: the engine
// AUTO-ROUTE paths reach a real person's phone with no permission check of any
// kind. `channel-push.ts` (the end-of-turn reply push) and `turn-closures.ts`
// (the engine ack) between them hold seven such arms, and three transports —
// iMessage, SMS and the in-call TTS push — go straight to a bridge, to Twilio
// and to a live call without passing through `executeTool` at all. Only the
// Teams and email arms are gated today, and only ACCIDENTALLY: they synthesize a
// tool call, so `mayWriteWorkspace` happens to ask `mayUseChannel` for them.
//
// The plan's own words are why this lands here rather than being handed up a
// fourth time: *"channel doors take agent identity (killing the `isPrimaryAgent`
// hardcode)"*. A door that any agent can walk through is not a door.
//
// ── THIS IS A NARROWING, AND THE VICTIM IS NAMED ──
// The task brief offered "the primary holds all channels post-migration" as the
// safety argument. MEASURED on the owner's box at `ac945a99`, it is not true of
// this path, and the correction belongs in the code rather than only in a report:
//
//     agent_id                              tool        channel    n
//     57b52025-…  (BehaviorBot, ronin)      auto-route  imessage  152
//     57b52025-…                            auto-route  email       7
//     57b52025-…                            engine-ack  imessage     3
//     kevin       (the primary)             auto-route  —           0
//
// Every engine-routed human delivery this box has ever made was sent by an agent
// that holds NO channel grant, and the primary has made none. A1's snapshot read
// the TOOL door's rule (`isPrimaryAgent`) because that was the only rule there
// was; this path had no rule to snapshot, so no derivation could have preserved
// it. There is therefore no behaviour-preserving way to gate this path, which is
// exactly why three phases handed it up — and the decision to spend that cost is
// recorded in the task brief, not taken here.
//
// What that costs is bounded and visible: an agent the owner wants auto-routing
// gets the channel ticked on its Access panel (A3 built the control), and until
// then the refusal is a LEDGER ROW, never a silent drop — the reply is already
// persisted and broadcast to the dashboard before any arm below runs, so the
// owner loses a channel hop, never the answer.
// ════════════════════════════════════════════════════════════════════════════

import type { AccessChannel, Channel } from '@dojo/shared';
import { mayUseChannel } from './read.js';

// `Channel` and not `ReplyDestination`, because the two sites this serves hold
// different values of the same idea: `channel-push.ts` has a resolved
// `ReplyDestination`, `turn-closures.ts` has the counterparty's `Channel`. The
// first union is a subset of the second, so taking the wider one means neither
// caller casts — and a cast at a permission door is a place the type system
// stopped helping.

/**
 * The ACCESS channel a reply DESTINATION reaches a human on.
 *
 * `channelForTool` cannot answer for these sites: they have no tool name, they
 * have a routing decision. The two unions disagree on one member and it is a
 * real trap rather than a naming quibble — the routing/ledger union says
 * `'phone'` for a live call while `ACCESS_CHANNELS` says `'voice'`, so a gate
 * written by pattern-matching the string would silently never fire for voice.
 *
 * `'dashboard'` answers `null`: the dashboard is the owner's own screen, not an
 * owner channel, and it is where a refused reply still lands. A grant has no
 * opinion about it and must not acquire one, or a narrowed agent would go mute.
 * `'a2a'` and `'engine'` answer `null` for the same reason in the other
 * direction — they reach no human at all, and inventing a refusal for
 * agent-to-agent traffic is precisely what `channelForTool`'s own note forbids.
 */
export function channelForDestination(destination: Channel): AccessChannel | null {
  switch (destination) {
    case 'imessage': return 'imessage';
    case 'sms': return 'sms';
    case 'teams': return 'teams';
    case 'email': return 'email';
    case 'phone': return 'voice';
    case 'voice': return 'voice';
    case 'dashboard': return null;
    case 'a2a': return null;
    case 'engine': return null;
  }
}

/**
 * May the engine route THIS agent's reply to a human on this destination?
 *
 * One predicate for all seven arms and for the in-call TTS push, and it is the
 * SAME `mayUseChannel` that ladder row 7, the `cat/comms.ts` handler walls, the
 * A3 panel's reader and `capabilityClause` ask. Owner ruling 1's master switch
 * is applied inside it (`channelTierOf`), so an agent whose master is off is
 * refused here without that rule being written a second time.
 */
export function engineMayRouteTo(agentId: string, destination: Channel): boolean {
  const channel = channelForDestination(destination);
  return channel === null || mayUseChannel(agentId, channel);
}

/** The ledger `detail` for a refused route. One sentence, one writer, so the
 *  dashboard's held/refused rows read the same whichever arm wrote them. */
export function engineRouteRefusalReason(destination: Channel): string {
  const channel = channelForDestination(destination);
  return `withheld: this agent holds no ${channel ?? destination} channel grant, so the engine did not auto-route its reply (the reply is in the dashboard chat)`;
}
