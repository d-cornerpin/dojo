# Dojo Issues Log — surfaced during the channel-attribution redesign testing

Issues observed while building/testing the message-attribution redesign (see
`MESSAGE-ATTRIBUTION-REDESIGN.md`). Logged here so they aren't lost; **revisit
after the channel-attribution work is complete.** Each notes whether the
redesign caused it (none did — these are pre-existing engine/model behaviors the
multi-channel battery exposed) and a proposed direction.

All observations are from the dev server, agent `kevin` (DeepSeek V4 Pro),
2026-06-25, during the isolated multi-channel round-trip battery
(`dev-test-tools/battery.mjs`). Nothing here is committed.

---

## RESOLVED (PRODUCTION REGRESSION) — v3.1.10-preflight.1 crashed on startup
**Status: FIXED (this session). Caused by this redesign; shipped, then fixed.**
After a production box updated 3.1.9 → 3.1.10-preflight.1 the server would not
boot and crash-looped. `platform.stderr.log`:
`Error: Cannot find package '.../node_modules/@dojo/shared/src/index.ts'
imported from .../packages/server/dist/gateway/ws.js` (`ERR_MODULE_NOT_FOUND`).
The crash is at module-load, before migrations run, so the DB was untouched.
**Root cause:** this redesign added the first-ever *runtime* (value) imports of
`@dojo/shared` into server code (`deriveOrigin`, `conversationKey` in `ws.ts`,
`loop.ts`, `counterparty.ts`, `store.ts`, `chat.ts`, `agents.ts`). `@dojo/shared`'s
`package.json` points `main`/`types` at `./src/index.ts`, and the package ships
only `dist/`, not `src/`. Dev (`tsx`) and `typecheck` (`tsc`) both resolve the
real `src`, so neither caught it; only the compiled, packaged artifact failed.
Before this redesign the server only *type*-imported `@dojo/shared` (erased at
compile), so production never resolved it at runtime.
**Fix:**
1. `deploy/build-package.sh` rewrites the shipped `@dojo/shared/package.json`
   `main`/`types` → `./dist/index.js` / `./dist/index.d.ts` (the dir that is
   actually bundled). Dev/tsx/typecheck untouched.
2. `deploy/release.sh` now smoke-boots the packaged artifact (unzip → `npm
   install` → `node dist/index.js`) and refuses to publish on any module
   resolution error. Verified positive (good build boots, migrations run) AND
   negative (reintroduced the bug → gate fails with the exact stack trace).
3. `DOJO_SKIP_SYSTEM_DEPS=1` guard in `ensure-system-deps.ts` so the gate boot
   never invokes Homebrew / network as a side effect.
**Recovery used on the box:** restored `~/.dojo/platform.backup-3.1.9` (the
backup the updater makes), then switched the channel to Stable. To make that a
one-click action in future, added an offline menu-bar **Roll Back** (
`deploy/scripts/rollback.sh` + `menubar/DojoMenuBar.swift`), and made the
auto-updater refresh `~/.dojo/scripts` so the script reaches boxes via update.

---

## RESOLVED (PREFLIGHT.2 REGRESSION) — duplicate-project thrash spiral from turn re-trigger
**Status: FIXED (preflight.3). Caused by the preflight.1/2 turn-serialization work.**
A real user request (set up a recurring GI-email digest) made the agent spawn ~5
duplicate projects, re-read the same emails each pass, suppress its own replies,
and ignore "STOP" until the user typed "JUST STOP". Root cause: the `conv_key`
"served" tag was written ONLY on turn-ends that reached a terminal human reply
(`loop.ts` ~4408) or `[no-reply]` (`loop.ts` ~2292). A turn that did real,
NON-IDEMPOTENT work but ended any OTHER way (reply suppressed by the
idle-with-in_progress nudge, cut off by a gate/limit, or handed to the PM via
`send_to_agent`) tagged nothing, so `getWaitingHumanConversations` kept reading
the conversation as unanswered and the runtime drain (`runtime.ts` ~597)
re-triggered the SAME message. The agent redid the whole task, duplicating side
effects, until `MAX_DRAIN_STUCK` (4). The flawed assumption was in the code
comment itself: "a turn interrupted mid-task tags nothing, so it stays waiting and
resumes" — it equated "no terminal reply" with "did no work".
Fix: CLAIM the conversation at turn pickup (`loop.ts` ~428) by stamping the
trigger inbound's `conv_key`, so it reads as served regardless of how the turn
ends. One guarded UPDATE on the single trigger row; restart-durable (DB);
idempotent (`conv_key IS NULL`); invisible to content-scoping (user rows scope by
origin, not `conv_key`). A genuinely newer message in the same conversation has a
higher rowid, so it still reads as waiting and is served next; only the
self-re-trigger of the message being handled is killed. Continuing a long task
stays the tracker/PM's job, never a re-run of the user's message.
Verified on dev: the same GI scenario now creates ONE project (was ~5), the
trigger message carries `conv_key`, zero drain re-triggers, zero suppression
loops. Regression channel routing 12/12, counterparty 5/5, and a deterministic
fairness test confirms claiming one conversation does not strand a second waiting
sender.

---

## RESOLVED — A2A `send_to_agent` loop / agent ignoring engine STOP
**Status: FIXED (this session).**
On an A2A turn the agent looped `send_to_agent` (observed 12 calls) and ignored
the thrash-gate "STOP" 9+ times. Root cause: deadlock — the thrash gates blocked
the agent's only legitimate reply (`send_to_agent`) while telling it to "respond
to the USER with text," but on an A2A turn there is no user and A2A-turn text is
suppressed, so there was no valid exit.
Fix: (a) exempt `send_to_agent`/`broadcast_to_group` from both thrash gates on
A2A turns (`counterparty.kind === 'agent'`) — `loop.ts` ~3332/3355; (b) hard
turn-end after a successful A2A reply — `loop.ts` ~4051. Verified: 1 send, 0
STOP, reply recorded, turn idles, invisible to user.

---

## RESOLVED (ROOT) — Turn serialization under concurrency (a top-level solve, not a patch)
**Status: FIXED (this session). Exposed + verified with two realistic batteries.**
Under realistic concurrent multi-channel load the agent tangled turns: a turn
that ended mid-task resumed under whoever's message was newest, so it finished an
old task but routed it to a new counterparty (a colleague's Teams answer
delivered to a client's email thread), planning text leaked to the dashboard, a
big first task starved the rest, one conversation's work bled into another's
reply (a colleague who asked about a 3pm review got a reply about the owner's
dentist appointment), and a reply to Crystal routed to David. Five symptoms, all
from how a turn is bound to a conversation.
The solve (all structural):
1. **FIFO continuity** — the turn's counterparty is the human conversation that
   has WAITED longest with an unanswered message (rowid-precise, session-scoped);
   its latest message is the trigger (multi-part answers together). A turn only
   marks a conversation "served" when it actually delivers a reply / [no-reply],
   so an interrupted turn leaves it waiting → the next turn RESUMES the SAME
   counterparty and routes to it. (agent/v2/counterparty.ts getWaitingHumanConversations,
   turn-state.ts servedConversations by rowid.)
2. **Drain** — after a turn, if conversations are still waiting the runtime
   queues a wakeup so the agent works through the whole queue instead of going
   idle with messages stranded; bounded by MAX_DRAIN_STUCK so an unservable head
   can't spin (runtime.ts finally).
3. **Content isolation** — each turn stamps its OWN messages (assistant/tool)
   with the conversation's key (migration 076 conv_key); the live-tail scoper
   keeps a self-message only for its own conversation, so one counterparty's work
   can't bleed into another's turn (assembler scopeToHumanConversation).
4. **iMessage recipient** — the reply routes to the TURN's counterparty address,
   not the racy in-memory pendingIMResponseMap that got overwritten when another
   iMessage arrived mid-turn; not-a-safe-sender ⇒ suppress, never fall back to
   texting the owner (imessage-bridge.sendResponseViaIMessage + loop).
Verified: clean 3-way concurrency (Crystal iMessage / colleague Teams / client
email ~1s apart) routes each to the right recipient + channel + topic with NO
bleed (markers: Reply routed via iMessage to Crystal / Teams to colleague /
email to the Invoice thread); the realistic battery now serves multiple
conversations instead of one. Regression 12/12, scoping, normal conv, turn
classification, structural-origin robustness all green.
Follow-ups (BOTH now resolved):
- **Restart durability** — DONE. "Served" is no longer an in-memory map; it's
  derived from the DB (a conversation is answered when an own message tagged with
  its conv_key comes after its latest inbound). The whole servedConversations
  map + markConversationServed were removed. Verified: with ONLY DB state, an
  answered conversation is not re-served and an unanswered one is picked.
- **Head-of-line** — DONE. When other human conversations are waiting behind the
  current one, a just-in-time engine hint (assembler, only when othersWaiting>0,
  with the count) offers the agent to ack + track a large request as a project
  and move on (quick-reply default). Verified: hint fires with the right count
  when 3 wait, silent when alone; in the realistic battery the agent opened a
  tracker project for a client request and served the others instead of blocking.

## RESOLVED (ROOT) — Engine events poisoned turn classification → A2A text leaked to dashboard
**Status: FIXED (this session). Verified with the instrument + end-to-end.**
The deepest root behind the "Let me reply to Kelly" A2A chatter showing on the
dashboard. Turn classification keyed off a brittle prose-exclusion list:
- The trigger query (loop.ts ~405) selected the latest role='user' row excluding
  ONLY `[SOURCE: SYSTEM` / `[A2A:` / `[SOURCE: AGENT MESSAGE` — NOT tracker /
  scheduler / thrash-gate / healer engine events. So an engine event became the
  turn's "trigger" and resolved to a malformed counterparty
  `{kind:user, relation:engine, name:"a contact", channel:dashboard}` (confirmed
  in the ATTRIB log).
- The `unansweredUser` query (loop.ts ~509) had the same hole, so an unanswered
  engine event made `hasUnansweredUser=true`, forcing `isA2ATurn=false`. With the
  turn not recognized as A2A, `interAgentTurn` was false, so the agent's reply
  text was persisted with `source=NULL` instead of `source='a2a'` → it rendered
  on the dashboard.
Fix: both the trigger selection AND the unanswered-human check now classify by
STRUCTURED origin (`deriveOrigin().kind`, reading the origin_kind column + the
shim) — the latest GENUINE human (kind==='user') is the trigger; engine events
(kind 'engine') and A2A (kind 'agent') are never the trigger and never count as
an unanswered user. This is exactly what the write-side origin_kind column was
built to enable. Verified: (1) an engine event as the latest row resolves to the
real human counterparty, not "a contact/engine"; (2) an A2A turn with engine
events in history is correctly classified A2A; (3) end-to-end, that A2A turn's
assistant text is tagged source='a2a' (hidden), nothing on the dashboard, no
human send. Regression 12/12, scoping scenarios, normal conv, robustness green.
Note: the calendar+dinner "one message → two answers" symptom is a SEPARATE,
nondeterministic model behavior (answering multiple pending same-sender messages);
after this fix the repro answered only the asked question, but it is not a
deterministic engine bug and is not claimed fixed.

## RESOLVED — Two senders merged into one role='user' message (the core disease)
**Status: FIXED (this session). Verified with the context-dump instrument.**
The assembler scoped the live tail by A2A only (`stripA2AFromTail`), never by the
human counterparty. So when the owner typed on the dashboard while a friend had
recently texted on iMessage, BOTH stayed in the tail and the integrity pass
merged them into ONE role='user' message prefixed with the friend's
`[SOURCE: IMESSAGE FROM Crystal …]` marker — the model could not tell who asked
what. Reproduced directly in the assembled model context.
Fix: `scopeToHumanConversation(tail, counterparty)` (memory/assembler.ts) keeps
only the counterparty's conversation (matched via `conversationKey`), drops other
humans and A2A, leaves engine events for the EVENTS lane. Verified: David /
Crystal / Kelly turns each show exactly one counterparty, 0 cross-sender leaks;
a normal single-counterparty conversation is unchanged (no over-pruning);
channel routing still 12/12.

## RESOLVED — A2A reply routed to a HUMAN channel (Kelly's answer texted to David)
**Status: FIXED (this session). Verified under the exact failing condition.**
On an A2A turn the agent answers via send_to_agent. If it also emitted trailing
text, `resolveReplyDestination` had no A2A concept: it fell through to the
dashboard default and the presence='away' override then promoted it to iMessage,
texting the OWNER an answer meant for another agent (observed in the battery:
Kelly's "deployment status" A2A answer delivered to David via iMessage, marker
`[Reply routed via iMessage to David]`). Violates invariant #2 (A2A replies never
cross to a human channel).
Fix: loop.ts end-of-turn routing forces the no-auto-route destination when
`counterparty.kind === 'agent'`. Verified with presence='away' (the trigger):
A2A reply now goes ONLY to Kelly via send_to_agent — zero human outbound, zero
routing markers; confirmed again in the full battery (A2A case now suppressed/
invisible).

## RESOLVED — Channel-turn DOUBLE REPLY (agent responded twice, NOT a display bug)
**Status: FIXED (this session). Verified in isolation.**
This was misdiagnosed earlier as a display dedup issue. It is the agent actually
RESPONDING TWICE — the two bubbles are often slightly different because they are
two separate generations. Root cause: `renderReplyDestination` hardcoded the
OWNER's name regardless of who texted — so on a friend's iMessage the prompt said
"iMessage to <owner>" AND "imessage_send is reserved for anyone other than
<owner>." A friend IS someone other than the owner, so the agent both called
imessage_send to the friend AND wrote terminal text (auto-routed) = two replies.
Fix: thread the actual counterparty's name into the prompt context
(`replyRecipientName` = turnContext.counterparty.name) and have
renderReplyDestination name the REAL recipient, plus an explicit "Do NOT also
call <tool> to reply to <recipient> — that sends a duplicate." (iMessage / Teams /
email / SMS branches). Verified isolated: a friend's iMessage now yields ONE
terminal text, 0 explicit imessage_send calls, routed `[Reply routed via iMessage
to Crystal]` (the correct recipient). Regression 12/12, scoping, normal conv,
structural-engine robustness all still green.

## OPEN-8 — Multi-source routing: A2A interleaving an iMessage turn can default the reply to the OWNER
**Severity: medium. Caused by redesign: no (pre-existing, see memory
imessage-multisource-routing-rootcause). Surfaced by the battery's broken isolation.**
- Symptom: in a battery run where a live A2A from Kelly arrived DURING Crystal's
  iMessage turn, the dinner reply routed `[Reply routed via iMessage to David]`
  (the owner) instead of to Crystal, and an A2A planning line also reached David.
  In strict isolation (one inbound, no bleed-in) the same cases are correct:
  reply→Crystal, A2A→suppressed.
- Likely root: when send_to_agent / a second inbound interleaves, the pending
  iMessage recipient (Crystal) gets wiped, so iMessage routing falls back to the
  owner; and the turn's counterparty can resolve to the wrong sender when two
  arrive together. This is turn-serialization / pending-recipient state, not the
  attribution projection.
- Proposed direction: make the pending-iMessage-recipient survive an interleaved
  send_to_agent (don't clear it on A2A activity), and ensure each inbound gets its
  own serialized turn with its own counterparty rather than sharing one turn.

## RESOLVED (write side) — Engine events now carry STRUCTURED origin, not just prose
**Status: FIXED (this session). Verified the read-shim is no longer load-bearing.**
Migration 075 adds origin_kind + origin_intent to messages and backfills existing
engine rows (229 rows: tracker 159, scheduler 35, system 15, thrash_gate 9, …),
strictly excluding channel (inbound_meta) and A2A (a2a_*); 0 channel/A2A rows
wrongly stamped. deriveOrigin reads origin_kind FIRST (prose is now only a
fallback for un-backfilled rows). The dominant writers (tracker/notify.ts,
scheduler/runner.ts) stamp the columns going forward. Verified: the shim
load-bearing audit dropped from 19 tier-diverging rows to 0; a NEW engine event
with an UNRECOGNIZED prose marker ([WIDGET FROBNICATE]) + origin_kind='engine' is
still classified engine and routed to the EVENTS lane (it would have leaked into
the live tail under the old prose-only shim). Regression 12/12, scoping
scenarios, normal conversation all green.
Remaining (non-blocking): the low-volume loop.ts nudges ([Engine thrash gate],
[System: empty/incomplete response]) and a few rare writers still emit prose
role='user'; they use recognized prefixes so the shim covers them — migrate when
convenient, then the prose-shim + visibility regex fallback can be deleted.

## OPEN-3 (update) — A2A turns no longer LEAK to a human, but still do internal busywork
**Severity: low (efficiency). Human-leak portion RESOLVED this session.**
- Three human-delivery paths on an A2A turn are now closed (invariant #2):
  (a) trailing-text auto-route forced to no-human on agent turns (loop.ts reply
  destination); (b) deterministic A2A turn-end checks result.toolCalls instead of
  the racy state.sentToAgentThisTurn (set inside parallel runOne callbacks);
  (c) the show_to_user attachment safety net is drained-but-not-surfaced on agent
  turns. Verified: battery A2A case is none/none (invisible to user); focused
  presence='away' test shows zero human outbound.
- Residual (pre-existing, now HARMLESS): the model still sometimes thrashes
  send_to_agent and does file work on an A2A turn before it settles — wasteful but
  none of it reaches a human. Root is the weak model not single-shotting the A2A
  reply; the engine guards now contain the blast radius. Tighter containment
  (restrict A2A-turn tools to send_to_agent + reads) is a possible follow-up.

---

## OPEN-1 — DeepSeek V4 Pro emits malformed JSON tool args; engine rejects (no repair)
**Severity: medium-high. Caused by redesign: no (model + engine robustness).**
- Symptom: `tracker_update_status` call rejected — `OpenAI: malformed tool call
  JSON arguments` then `Rejecting tool call with malformed arguments`. The args
  arrive wrapped as `{__malformed_args: "..."}`. Happens with long/complex string
  fields (e.g. a multi-line `result`).
- Evidence: log `component:"model"` `"OpenAI: malformed tool call JSON arguments"`
  `{toolName:"tracker_update_status"}`; `tools.ts:4060` `__malformed_args` path.
- Impact: the agent "completes" a task but the call is rejected → it retries →
  burns turns → can cascade into the thrash breaker (OPEN-4).
- Proposed direction: the engine should attempt a structured repair of malformed
  tool-call JSON (common failure modes: unescaped newlines/quotes in long string
  args) before rejecting, OR re-prompt the model with a targeted "your JSON for
  arg X was malformed; resend just that call" instead of a generic rejection.
  Build to the weak-model floor — DeepSeek WILL emit malformed args.

## OPEN-2 — Anti-hoarding gate refuses legitimate multi-task `tracker_get_status`
**Severity: medium. Caused by redesign: no (pre-existing gate).**
- Symptom: `[System: anti-hoarding gate engaged. The tracker_get_status call you
  just made was refused because you've loaded ...]`, and `Refused: engine
  anti-hoarding...` tool results, while the agent was legitimately gathering
  status across several tracker tasks to answer an emailed "send me the project
  status" request.
- Evidence: persisted system message "anti-hoarding gate engaged"; gate at
  `loop.ts` ~3384 (`Anti-hoarding gate (v2.5.43)`).
- Impact: the agent can't read the status it needs → gives a partial answer or
  thrashes.
- Proposed direction: the anti-hoarding gate counts loading-tool calls without
  "structuring" — but reading N distinct tasks' statuses to answer a status
  request is not hoarding. Consider exempting read-only tracker status calls with
  DISTINCT ids, or counting by distinct-target rather than raw call count.

## OPEN-3 — `send_to_agent` thrash-gated on USER turns (PM coordination blocked)
**Severity: medium. Caused by redesign: partially exposed (my A2A exemption only
covers A2A turns).**
- Symptom: on email/Teams user turns where the agent coordinated with the PM
  (`send_to_agent` to kelly), the loop detector's cross-turn window tripped and
  returned "STOP — you have called `send_to_agent` N times…", blocking legitimate
  coordination. (On A2A turns this is now exempted; on user turns it is not.)
- Evidence: persisted "STOP — you have called `send_to_agent`" tool results
  during user-turn cases; `classifiers/loop.ts:201` (`loopDetector`),
  `MAX_REPEATS_BEFORE_BREAK`.
- Impact: the agent's PM coordination is blocked mid-task.
- Proposed direction: the loop detector windows `send_to_agent` by canonical
  signature across turns; distinct legitimate sends (different thread/intent)
  should not count together. Consider keying the window by thread, or resetting
  the `send_to_agent` window per outer turn, or a higher threshold for A2A tools.

## OPEN-4 — Thrash-gate breaker auto-blocks a task (cascade)
**Severity: medium. Caused by redesign: no.**
- Symptom: `v2: thrash gate breaker tripped — task auto-blocked` — a tracker task
  was auto-blocked after the agent repeatedly hit gates (OPEN-1/2/3) without
  making "progress."
- Evidence: log `component:"v2-loop"` `"thrash gate breaker tripped — task
  auto-blocked"`; `loop.ts` ~838 (`THRASH_GATE_BREAKER_LIMIT`).
- Impact: legitimate work gets auto-blocked because the *engine's own gates*
  prevented progress — the breaker punishes the agent for the gates' false
  positives. This is the most user-visible "everything is erroring" symptom.
- Proposed direction: fix OPEN-1/2/3 (the root false-positives); the breaker is
  correct in principle but is currently tripped by upstream gate errors rather
  than genuine agent thrashing.

## OPEN-5 — Unknown sender on the agent's OWN iMessage line gets an auto-reply (test-label vs policy)
**Severity: low (needs a policy ruling, not clearly a bug). Caused by redesign: no
(prior-phase authorization; NOT touched by Phase 6, which is display-only).**
- Symptom: in `battery.mjs` the "iMessage from UNKNOWN number — expect SUPPRESSED"
  case produced an outbound iMessage to the unknown number: "This is an AI assistant.
  You may have the wrong number — who are you trying to reach?" The test label
  expected no auto-reply.
- Evidence: the inbound row's `inbound_meta` is
  `{"channel":"imessage","accountKind":"agent","authorized":true,"sender":"+19998887777","relation":"third_party"}`.
  Because the message hit the AGENT's own iMessage line (`accountKind:agent`), the
  producer marks it `authorized:true` (auto-reply-eligible) while correctly tagging
  `relation:third_party` (unknown). The agent then sent a generic, safe clarifying
  reply.
- Impact: none to the security invariant — the agent did NOT act on the unknown
  sender's behalf, reveal owner data, or perform a task; it only sent a "wrong
  number?" probe. The mismatch is between the battery's "expect SUPPRESSED" label
  and the intended own-line behavior. (Model judgment is also a factor: DeepSeek may
  reply on some runs and stay silent on others.)
- Proposed direction: decide the policy — either (a) accept safe clarifying replies
  to unknowns on the agent's own line and update the battery label, or (b) suppress
  auto-replies when `relation==='third_party'` even on an agent-kind line and have
  the agent surface it as a dashboard notification instead. Needs David's ruling.

---

## OPEN-9 — Close-the-loop: agent promises to relay to the owner, then never does
- Symptom: a known contact (iMessage) said "scratch the beer — next week?" and the
  agent replied "I'll ask David about next week and let you know" — but then never
  surfaced anything to the owner and created no reminder/task to do so. An empty
  promise to a third party. This is one of the nine behaviors the attribution
  battery probes ("close-the-loop / respond-once-but-follow-through").
- Evidence: attribution-battery-2 (Tidewater) run 4, kevin msg rowid 41319
  ("No worries. I'll ask David about next week and let you know.") routed to Cory
  at 41320. No subsequent kevin message (41319→end of run, last scenario at 41365)
  mentions the beer / next week / Cory to the owner; `tasks` and scheduled
  reminders mentioning Cory/beer = 0. NOT a capability limit: in the same window
  the agent DID proactively surface other items to the owner (e.g. rowid 41351,
  "Renata just emailed a follow-up…"), so it can surface — it just dropped this one.
- Likely root: no follow-through mechanism when the agent commits to relay
  something to the owner. The turn ends after the reply to the counterparty; nothing
  converts "I'll ask David" into either an in-turn owner message or a queued
  reminder/task, and the next (unrelated) turn moves on. Hard for the engine to
  catch every "I'll do X" promise mechanically, so partly model judgment — same
  family as the consignment owner-gating item.
- Caused by current work? No. Unrelated to the message-attribution redesign or the
  baseline memory-bleed fix; the routing/attribution itself was correct (right reply
  to the right counterparty on the right channel). This is a follow-through gap.
- Proposed direction: TBD per David ("log it, don't fix yet"). Candidate fixes when
  picked up: (a) compose-time guidance — when a reply promises to relay/ask the
  owner, also create a reminder or send the owner a note in the same turn; or
  (b) treat social-promise follow-through as owner-trainable model behavior (the
  same call David made on consignment) and leave it. Decide before building.

---

## OPEN-10 (DECIDED: out of scope) — Agent commits an owner-gated commercial term without surfacing it
- Symptom: a wholesale buyer (authorized email contact) asked about decaf supply AND
  consignment. The agent replied committing to a commercial term on the owner's
  behalf — "Happy to do consignment for the first month… then we switch to standard
  wholesale terms month two" — without surfacing the decision to the owner first.
  Inconsistent with its own behavior in the same reply: it correctly gated PRICING
  ("locking down the final numbers with David") and, in other turns, correctly
  surfaced the lease decision rather than committing. So it knows some things need
  owner sign-off; it just drew the line in the wrong place for consignment terms.
- Evidence: attribution-battery-2 (Tidewater) run 2, kevin's reply to
  tomas@harborview.example.com (the "Good to hear from you, Tomas — both requests are
  no problem at all… Consignment: Happy to do consignment for the first month…"
  message). Routing itself was correct (right counterparty, right channel = email);
  the defect is in WHAT it promised, not where it sent it.
- Likely root: model judgment on the floor model (DeepSeek V4 Flash). The engine
  can't mechanically tell "yes, we stock decaf" (fine to confirm) from "yes, we'll do
  consignment for month one" (a financial commitment that should be owner-gated) —
  that line is semantic. Same family as OPEN-9 (close-the-loop follow-through).
- Caused by current work? No. Routing/attribution was correct; this is a
  commercial-judgment gap, not an attribution-redesign or baseline-memory issue.
- DECISION (David, 2026-06-27): OUT OF SCOPE — not an engine-correctness defect.
  Users train their own agents on what they may or may not commit to on the owner's
  behalf. Logged for the record only; no fix planned. If revisited, the candidate
  fix is compose-time guidance ("if a reply commits us to terms/money/dates, surface
  to the owner first"), kept as just-in-time advice, NOT an engine-enforced block.

---

## Test scaffolding — REMOVED before the Preflight commit (record of what was stripped)
The following dev/test-only scaffolding was added during the redesign and STRIPPED
out before committing to Preflight (none of it ships). Kept here as a record:
- `packages/server/src/agent/v2/loop.ts` — the `logger.info('[ATTRIB] turn counterparty', …)` diagnostic line (after `resolveTurnCounterparty`).
- `packages/server/src/gateway/routes/dev.ts` + its mount in `gateway/server.ts` (`/api/dev`) — the simulate-inbound / outbound-drain / sim-mode endpoints AND the new `GET /api/dev/context-dump/:agentId` (runs the real assembler and returns exactly what the model sees — the ground-truth instrument used to find the cross-sender merge and the EVENTS-lane behavior). Gated to non-production, but should not ship.
- `packages/server/src/agent/v2/sim-outbound.ts` + the sim-capture intercepts in `tools.ts:executeTool` and `services/imessage-bridge.ts:sendResponseViaIMessage` + `simulateInboundIMessage` / `setSimulatedInboundSender` in imessage-bridge — dev simulation only.
- Seeded TEST safe-senders in the dev DB `config.imessage_approved_senders` (David `+15550000000` is_primary, Crystal `+15550000001`) — the real config was empty; clear before any real use.
- `dev-test-tools/` helpers (battery.mjs, regression-channels.mjs, vischeck.mjs, inbound, origin-test.mjs, counterparty-test.mjs) are NOT in git — fine to keep.

## Note on testing discipline (for myself)
When a test surfaces engine errors, surface them in the report — do not call a
run "clean" based only on the happy-path result. Fix on the spot, or log here.
Test gotchas learned: (1) use UNIQUE questions per test — re-asking the same
question trips the duplicate-response guard and looks like an empty reply;
(2) after editing server files, wait for the tsx reload to land (uptime resets)
before testing, or you test stale code; (3) clear stale state between tests —
`a2a_replies`, stranded `tasks` (status in_progress/on_deck), and reset the
session — or a backlog/loop bleeds in; (4) when grepping logs by a sqlite
`datetime('now')` timestamp, note it uses a SPACE not a `T`, so naive string
compares against ISO log timestamps are wrong.
