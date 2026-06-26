# Message Attribution Redesign, "every message knows who it's from, and every decision reads it"

**Status:** Revised after implementation + production exposure. The data model (the structured origin) shipped and is correct. The *consumption* was incomplete, and that incompleteness produced a string of failures (turn hijack, model relapse, ack-and-ghost, double-replies, duplicate work). This revision promotes the consumption rules to first-class, so the spec and the code finally agree.

**Goal:** Make it structurally impossible for an agent to confuse who said what, AND impossible for the engine itself to mis-route a turn. Every message carries explicit, structured attribution; every decision that depends on "who / what channel / should I reply" is driven by that attribution, never by a prose marker, a `kind`-only check, or a parallel signal.

---

## 0. Invariants and the prime directive

**Three invariants that must never regress** (each is a required regression test at every phase):
1. **Channel distinction.** The agent always knows the channel (iMessage, dashboard, email, Teams, SMS, phone/voice, A2A) and the sender.
2. **Reply routing stays on-channel.** iMessage is answered on iMessage, email with an email, A2A with `send_to_agent`, etc. Replies never cross channels.
3. **Sender authorization.** "The owner" vs "a friend on the safe-sender list" vs "an unknown sender / a notification about the owner's inbox" is preserved; the agent never acts or replies on an unauthorized sender's behalf.

**The prime directive (the lesson that this revision exists to encode):**
> **Every field of `MessageOrigin` has a named consumer. A field that is computed on every message but read in only one place is a bug, not a convenience.**

The first version of this redesign built `MessageOrigin` with an `authorized` flag and then read it in exactly one consumer. Every other decision ("is this a waiting conversation," "is this a user turn," "does this outrank a scheduled task," "what is the trigger") fell back to checking `kind` alone. The structured path existed but was bypassed, so the model still got confused and the engine made wrong turn decisions. The fix below is not new design; it is wiring the flag the design already defined into the decisions the design already described.

**Working agreement:** build on the dev server, commit nothing until David approves, and verify each phase against *real, adversarial* scenarios (a notification flood colliding with a scheduler fire, an agent finishing long PM-validated work, two senders at once), reading the **actual** assembled context, not greps. Synthetic batteries that only exercise genuine inbound are how the `authorized` gap shipped green.

---

## 1. The disease, in two layers

**Layer 1 (the original):** every inbound (owner on dashboard, owner on iMessage, a friend on iMessage, an agent over A2A, the PM, the scheduler, the tracker, a mailbox notification) is stored as `role='user'` and distinguished only by a text marker inside the content. A weak model cannot parse ~30 markers interleaved in one stream, so it collapses them into one mental counterparty.

**Layer 2 (discovered in production):** even after structured attribution was added, the **consumers kept using crude proxies**. The damage from this layer was worse than Layer 1, because now the *engine* (not just the model) made wrong decisions:
- A mailbox notification (`kind:'user'`, `authorized:false`) was counted as a real "waiting conversation," so it **outranked scheduled tasks** (the owner's automations silently stopped running) and **flipped agent turns into user turns** (suppressed A2A chatter leaked to the user as a relapse loop).
- Suppression and turn-end logic keyed off prose `includes('[SOURCE: …]')` instead of the counterparty.

Both layers have the same cure: **decide by the structured origin, and make sure every decision actually reads it.**

---

## 2. What exists today (the data model is done; consumption is the gap)

Shipped and correct:
- `messages` carries the attribution columns (`source`, `source_agent_id`, `a2a_*`, `inbound_meta`), plus `origin_kind` + `origin_intent` (mig 075) for engine events and `conv_key` (mig 076) for content-isolation / served tracking.
- `deriveOrigin(row): MessageOrigin` is the single projection; `rowToMessage` surfaces the fields on the shared `Message` type.
- Most producers stamp a complete `inbound_meta` with the correct `authorized` verdict (the safe-sender / account-kind gate in `channel-auth.ts`).

The gap is entirely on the read side: the consumers that decide turn behavior do not all read `authorized` (and a few still read prose). One producer (Twilio voicemail) still leans on the legacy prose shim instead of stamping `inbound_meta`.

---

## 3. The principle: three lanes, and `authorized` decides the lane for human inbound

Everything in an agent's context is exactly one of three things, and **the lane is a pure function of the origin**:

- **Lane 1, the conversation.** The live back-and-forth with the **one** counterparty the agent is answering this turn.
- **Lane 2, the agent's own mind.** Identity, memory, summaries, the current goal. "What you know," never a message from anyone.
- **Lane 3, awareness (events + notifications).** Things that happened, and things the agent should be aware of but is **not** in conversation with. Framed as events, never as a person talking to it.

**The lane-assignment rule (this is the correction, stated once and consumed everywhere):**

| Origin | Lane | Means |
|---|---|---|
| `kind:'user'` AND `authorized` | **Lane 1** (if it is the turn's counterparty) | A real conversation the agent owes a reply to. |
| `kind:'user'` AND **not** `authorized` | **Lane 3** | A mailbox notification or an unknown sender. The agent **sees** it and may **surface it to the owner**, but never answers it as a conversation. |
| `kind:'agent'` | Lane 1 if current counterparty, else **Lane 3** | A2A from the counterparty is the conversation; A2A from anyone else is an event with its own queued turn. |
| `kind:'engine'` | **Lane 3** | Tracker / scheduler / healer / system events. |
| `kind:'self'` | the agent's own output, scoped by `conv_key` | Belongs to the conversation it was produced for. |

The original draft said "Lane 3 = engine events" and "Lane 1 = same human+channel conversation," and quietly assumed `kind:'user'` always meant Lane 1. That is the self-contradiction that let a notification become a conversation. The `authorized` flag is the bridge the design always intended; the table above is that bridge made explicit.

**One definition derived from this rule governs the whole turn machine:**
> **"A conversation the agent owes a reply to" = `kind:'user'` AND `authorized`** (or the current A2A counterparty).

Everything that asks a version of that question reads this *one* definition: the trigger pick, the "is there an unanswered human" check, the runtime drain that re-wakes the agent, and the user-turn-vs-agent-turn classification. Fix the definition once and all of them become correct together. This is the single most important change in the revision.

---

## 4. Target architecture

### 4.1 `MessageOrigin` (unchanged shape; `authorized` is load-bearing)

```ts
type OriginKind = 'user' | 'agent' | 'engine' | 'self';
type Relation   = 'owner' | 'known_contact' | 'third_party' | 'agent' | 'engine';

interface MessageOrigin {
  kind: OriginKind;
  relation: Relation;
  channel: Channel | null;   // dashboard | imessage | teams | sms | email | phone | voice | a2a | engine
  senderName: string | null;
  senderId: string | null;
  threadId: string | null;
  intent: string | null;     // a2a intent OR engine event type (tracker.assigned, scheduler.fire, mailbox.notify, …)
  authorized: boolean;       // may the agent reply to THIS sender as a conversation
}
```

`deriveOrigin(row)` is the single source of truth, with a read-time shim for legacy prose rows. `authorized` means precisely "Lane 1 vs Lane 3 for a human." It is not advisory.

### 4.2 The turn opens by declaring its counterparty

One step (`resolveTurnCounterparty`) produces a `TurnCounterparty` from the origin and renders an always-present header the model anchors on ("This turn you are responding to **David**, your primary user, over **iMessage**. Everything marked EVENT or MEMORY is context, not David talking."). Generated from the origin, never from prose.

The counterparty for a turn is the **longest-waiting authorized conversation** (FIFO), or the A2A thread if this is an agent turn. A turn triggered by an *unauthorized* notification has no Lane-1 counterparty; its counterparty defaults to the owner, and the notification rides in Lane 3 (see 4.4): the agent's job is to decide whether to surface it to the owner.

### 4.3 Lane 1 is scoped to the counterparty AND `authorized`

The fresh-tail scope keeps only:
- **Human turn:** messages whose origin is the same conversation (channel + sender) **and** `authorized`. An unauthorized message on the same channel is never Lane 1.
- **Agent turn:** messages on that `a2a_thread_id` only.

This is the line the original draft got wrong (it scoped on channel + sender only). Adding `authorized` here is what stops a notification from masquerading as the conversation.

### 4.4 Lane 3 (awareness) is engine events PLUS unauthorized inbound

The assembler collects Lane 3 into one clearly-delimited envelope, rendered from structured origin:

```
=== EVENTS AND NOTICES SINCE YOU LAST ACTED (things that happened / things to be aware of, not people talking to you) ===
  · [tracker] You were assigned "Plan offsite" (task 3f2a)
  · [scheduler] Daily digest fired
  · [agent: Kelly] asked on thread a1b2: "status?"  (gets its own turn)
  · [email -> David's inbox] from billing@acme.com: "Invoice 91 overdue"  (a notification, not addressed to you; surface to David only if it matters)
```

The mailbox notification lives here, attributed honestly as an **email** from a **third party** to the **owner's** inbox. The agent reads it, and the only action it can take is to **surface it to the owner** (a Lane-1 reply to the owner) or ignore it. It is never a conversation it replies to. This is what makes "stay aware of everything, reply only to authorized" true at the same time.

### 4.5 The turn lifecycle (new section; this is where the session's turn-bugs are designed out)

A turn is not just "assemble context and call the model." It has a lifecycle with four guarantees:

1. **Claim at pickup.** The instant a turn picks up a conversation, that conversation is marked *served* (durably, via `conv_key`), independent of how the turn ends. A conversation that has been claimed is never re-picked, so the engine can never re-run already-done, non-idempotent work. (This kills the duplicate-project / drain-re-trigger class: an interrupted or messily-ended turn cannot resurrect the same request.)

2. **Respond once; never re-prompt a model that already replied.** If the agent has produced a user-facing reply this turn, the engine does not re-prompt it (no "you still have an open task, keep going" nudge that the weak model answers by re-replying). The engine reconciles bookkeeping itself. Re-prompting is allowed only when there was *no* reply yet (a genuine silent stop). (This kills the double-response class.)

3. **Close the loop.** A turn that completes work the **user** asked for owes the user a completion report. If the work finishes on an agent/engine turn (where user-facing text is suppressed, e.g. the agent was answering the PM when the last task validated), the engine schedules a single user-facing closeout turn so the agent always says "done, here is what I did" and never acks-and-ghosts. The completion report is bounded ("summarize, do not redo") and fires once.

4. **Reconcile, do not destroy.** When tracker state and the agent's words disagree (the agent said "done" but did not formally close a task), the engine **keeps the agent's reply visible** and reconciles the task in the background (pause a one-shot, reset a recurring, default a missing goal so the PM can validate). It never deletes a real reply to protect an internal invariant the user cannot see. (This kills the suppression-ate-my-reply class and the no-goal PM-revert ping-pong.)

### 4.6 The model call carries the counterparty

`ModelCallParams` gains `counterparty`. Providers stay 2-role; attribution rides in the structured header + the three-lane framing. The dashboard receives the turn's counterparty kind on `agent:status` so the composer can stay quiet during pure agent-to-agent turns (the thinking dots / stop button reflect "is the agent talking to *me*"). This is the counterparty surfaced to the UI, not a parallel signal.

---

## 5. Subsystem impact, stated as a producer/consumer contract

**Producer contract (every inbound stamps a complete origin; no prose-only inserts):**
- iMessage, Teams, Gmail, Outlook, SMS, live-voice, scheduler: already stamp complete `inbound_meta` / `origin_kind` with the correct `authorized` / `accountKind`.
- **Twilio voicemail (open gap):** still inserts a bare `[SOURCE: VOICEMAIL …]` `role='user'` row with no `inbound_meta`. It survives only because the legacy prose shim catches `[SOURCE:`. Fix: stamp `recordInboundMeta({ channel:'phone', accountKind:'agent', authorized:false, sender, phoneFromNumber, phoneCallSid })`. (Hardening, not a live bug, but exactly the kind of "leans on the shim the redesign exists to retire" that the prime directive forbids.)

**Consumer contract (every decision reads the structured origin):**
- `getWaitingHumanConversations` (the single "owes a reply" definition): `kind:'user'` **AND** `authorized`. This one change propagates correctly to the trigger pick, `hasUnansweredUser`, `isA2ATurn`, and the runtime drain, because they all derive from it.
- `scopeToHumanConversation`: Lane 1 keeps `kind:'user'` AND `authorized` AND same conversation; everything else drops to Lane 3 / its own turn.
- The assembler's EVENTS lane: include `kind:'engine'` **and** unauthorized `kind:'user'` inbound (4.4).
- Reply destination / routing: keep keying off `inboundChannel` (already gated on `authorized` by `resolveInbound`), so an unauthorized inbound never auto-routes a reply to the sender.
- Inter-agent suppression and the A2A reply guard: drive off `counterparty.kind === 'agent'`, not `content.includes('[SOURCE: PM AGENT POKE …]')`. Delete the prose tails.
- `classifyMessageForDisplay`: purely structured (`origin.kind` / `relation` / `authorized`); the prefix regex stays only as the origin-less fallback for optimistic/streaming bubbles.

**Audit rule (the prime directive, operationalized):** for each field of `MessageOrigin`, grep its consumers. `authorized` must be read by the waiting-set definition, the Lane-1 scope, and the EVENTS lane. If a field has zero or one consumer where the design implies several, that is the next bug.

---

## 6. What this deletes (the elegance payoff)

- The session band-aids that compensated for the unconsumed origin: the email "stamp it engine" hack, the prose `includes()` checks for PM-poke / group-broadcast, and any per-channel special-casing for "is this a conversation."
- The fragile A2A-vs-user turn heuristics, replaced by the single authorized-driven waiting-set.
- The "delete the agent's reply to keep the tracker consistent" suppression, replaced by reconcile-in-background.
- The remaining `[SOURCE: …]` prose taxonomy on the read side, replaced by structured origin (shim kept for legacy rows only).

Net: one `MessageOrigin`, one "owes a reply" definition, one turn header, three rendering lanes, and a turn lifecycle that closes its own loop. Fewer moving parts, and the parts that remain are driven by data instead of string-matching.

---

## 7. Failure modes we hit, and the design rule that makes each impossible

| Symptom (observed) | Root cause | The rule that prevents it |
|---|---|---|
| Owner's scheduled tasks (Tomorrow Brief, digest) silently stopped running | A mailbox notification counted as a "waiting human," outranking scheduler fires | Waiting-set = authorized inbound only (3, 4.3, 5) |
| Agent relapsed to its last topic on every new email | Phantom "waiting user" flipped agent turns into user turns; suppressed A2A text leaked | Same waiting-set fix; `isA2ATurn` derives from it |
| Agent did the work but never told the user ("ack-and-ghost") | Completion landed on a PM/A2A turn where user text is suppressed | Close-the-loop completion report (4.5.3) |
| Same project/request done 2-5 times | Conversation not marked served until a clean terminal reply; drain re-ran it | Claim-at-pickup served tracking (4.5.1) |
| Agent answered the same question twice, slightly reworded | Idle nudge re-prompted a model that had already replied | Respond-once / no re-prompt after a reply (4.5.2) |
| Agent's "done, here's what I set up" reply vanished | Close-out hardcap deleted the reply to keep the tracker consistent | Reconcile-do-not-destroy (4.5.4) |
| PM reverted completions forever ("no goal recorded") | Inline project tasks were created with no goal | Reconcile defaults a missing goal so PM can validate (4.5.4) |
| An email got treated as an internal engine message | A patch stamped it `engine` instead of fixing the consumer | An email is `kind:'user'`, `channel:'email'`, `authorized:false`; the lane is decided by `authorized`, not by lying about `kind` (3) |
| `authorized` computed but ignored everywhere | "Built the data, not the consumption" | The prime directive: every field has named consumers (0, 5 audit rule) |

---

## 8. Phasing and current state

**Shipped (preflight 3.1.10 series):** the structured origin + `origin_kind`/`conv_key` columns, `deriveOrigin`, counterparty resolve + turn header, Lane-1 scoping by conversation, the EVENTS lane for engine events, structured visibility, the claim-at-pickup served tracking, respond-once, reconcile-do-not-destroy, goal defaulting, and the composer turn-kind signal.

**Remaining (this revision's work, in order):**
1. **The waiting-set fix.** `getWaitingHumanConversations` and `scopeToHumanConversation` read `authorized`. Smallest change, largest blast radius: fixes the relapse, the scheduler hijack, and the A2A-leak together.
2. **The awareness lane.** EVENTS includes unauthorized inbound so the agent still sees and can surface notifications. Verify a notification is excluded from the reply-set **and** still reaches the owner when it matters.
3. **Close-the-loop completion.** A user-requested project that finishes on a non-user turn schedules one bounded completion report.
4. **Producer hardening.** Stamp the voicemail notification; delete the inter-agent prose `includes()` tails in favor of `counterparty.kind`.
5. **The prime-directive audit.** Per-field consumer check; retire the remaining legacy prose read paths once backfill confidence is high.

Each phase is verified against the adversarial scenario that exposed it, on the dev server, reading actual assembled context.

---

## 9. Risks and edge cases

- **A notification that genuinely needs a reply on the owner's behalf:** out of scope by Invariant 3; the agent surfaces it to the owner and the owner decides. (If a sender should be auto-answered, they belong on the safe-sender list, i.e. `authorized:true`, which puts them in Lane 1 by the rule, not by a special case.)
- **Recent unrecorded detail on an agent turn:** Kelly asks about something the owner said seconds ago. Answered from Lane 2 (memory / the agent's own files), with a short "recent activity" note in Lane 3, never by mixing in the owner's raw Lane-1 messages.
- **Owner on two channels at once:** two distinct Lane-1 conversations bridged by memory; each is its own authorized counterparty; the EVENTS lane can note "you also have an unread iMessage from David."
- **Group/squad threads:** genuinely multi-party Lane 1; the one correct place for per-message `senderName` tags, still from `MessageOrigin`.
- **Prompt-cache churn:** the turn header is volatile; place it after the cached prefix.
- **Completion-report duplication:** the close-the-loop turn fires once and only when the completing turn was non-user (so a normal user-turn completion, which already wraps up, never double-reports).

---

## 10. Decisions

1. **The lane of a human message is decided by `authorized`.** Authorized -> Lane 1 (a conversation). Unauthorized -> Lane 3 (awareness; surface to the owner, never reply to the sender). This is the spec correction the data model was always built for.
2. **One "owes a reply" definition** (`getWaitingHumanConversations`) feeds the trigger, the drain, `hasUnansweredUser`, and `isA2ATurn`. Fix it once.
3. **The prime directive holds going forward:** no field of the origin ships without a named consumer; no turn decision reads prose when the origin answers it.
4. **A turn closes its own loop:** claim at pickup, respond once, report completion to the user, reconcile bookkeeping without destroying replies.
5. **Where it rides:** dev server first, verified against the adversarial scenarios that exposed each failure, committed only on David's approval.
