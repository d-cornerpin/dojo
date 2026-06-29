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

## RESOLVED (was OPEN-8) — Multi-source routing addressed by the redesign's counterparty/waiting machinery
**Severity: medium. Caused by redesign: no (pre-existing, see memory
imessage-multisource-routing-rootcause). Surfaced by the battery's broken isolation.**
- Symptom: in a battery run where a live A2A from Kelly arrived DURING Crystal's
  iMessage turn, the dinner reply routed to David (owner) instead of Crystal, and
  an A2A planning line also reached David. In strict isolation the same cases were
  already correct.
- Root: the OLD racy in-memory `pendingIMResponseMap` got wiped by interleaved
  A2A activity, so iMessage routing fell back to the owner; and two inbounds could
  share one turn with the wrong counterparty.
- FIX (addressed by the attribution redesign — verified by code path, all three
  mechanisms the proposed direction called for are implemented):
  (1) Recipient survives: reply routing uses `counterparty.senderId` (stable,
  per-turn), NOT the racy pending map (loop.ts ~4700 — the documented Crystal→David
  fix). (2) Right counterparty under interleave: `getWaitingHumanConversations`
  picks the FIFO-oldest unanswered human as the trigger; `hasUnansweredUser` forces
  `isA2ATurn=false` whenever a human is pending, so the turn addresses Crystal and
  the A2A is deferred to its own later turn (one counterparty per turn). (3) No A2A
  leak to the human: text-riding-with-tools is suppressed (OPEN-3-update). The racy
  state that caused this is gone.
- Caveat: confirm with a real multi-source scenario (human iMessage + live A2A) once
  the battery's per-scenario isolation is fixed — the redesign analysis is complete
  but a clean interleaved live run wasn't re-captured.

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
  reply; the engine guards now contain the blast radius.
- DISPOSITION (this session): the send_to_agent-thrash part is further reduced by
  the OPEN-3 fix (coordination signature keeps `payload`, so identical re-sends are
  caught while distinct sends pass). The proposed "restrict A2A-turn tools to
  send_to_agent + reads" follow-up is DEFERRED on purpose: it would break
  legitimate A2A WORKER turns (a worker asked via A2A to research / write files
  genuinely needs full tools), and the residual is harmless inefficiency, not a
  correctness or leak issue. Closing as resolved-with-known-residual.

---

## RESOLVED (was OPEN-1) — DeepSeek V4 emits malformed JSON tool args; engine now repairs before rejecting
**Severity: medium-high. Caused by redesign: no (model + engine robustness).**
- Symptom: `tracker_update_status` call rejected — `OpenAI: malformed tool call
  JSON arguments` then `Rejecting tool call with malformed arguments`. The args
  arrive wrapped as `{__malformed_args: "..."}`. Happens with long/complex string
  fields (e.g. a multi-line `result`).
- Root: weak models emit raw, unescaped control characters (newlines/tabs/CRs)
  inside long string values, which is illegal JSON. The parse failed and the call
  was rejected outright, forcing a full retry that burned turns and fed the thrash
  breaker (OPEN-4).
- FIX (this session): added `repairToolCallArgs()` in `model.ts` (exported). On a
  JSON.parse failure it walks the raw string tracking in-string state and escapes
  any raw control char inside a JSON string (`\n`/`\r`/`\t` and other C0 via
  `\u00XX`), then re-parses (also trying a trailing-comma strip). Wired into BOTH
  the OpenAI/DeepSeek path and the Ollama path before falling back to
  `__malformed_args`. Genuinely truncated output still returns null → the existing
  clear "retry with valid JSON" path. Verified with focused tests: unescaped
  newline-in-`result`, tab+newline, and trailing-comma all repair and parse;
  valid JSON is unchanged; truncated JSON correctly yields null. Build-to-the-floor
  per the design law. (Eliminates the dominant feeder of OPEN-4.)

## RESOLVED (was OPEN-2) — Anti-hoarding gate no longer counts tracker reads
**Severity: medium. Caused by redesign: no (pre-existing gate).**
- Symptom: `[System: anti-hoarding gate engaged. The tracker_get_status call you
  just made was refused because you've loaded ...]` while the agent was
  legitimately gathering status across several tracker tasks to answer an emailed
  "send me the project status" request.
- Root: `classifiers/hoarding.ts` listed `tracker_get_status` / `tracker_list_active`
  / `tracker_get_project` in `LOADING_TOOLS`, so they counted toward
  `LOADING_GATE_THRESHOLD`. But the gate exists to stop EXTERNAL corpus-synthesis
  (loading docs/web/files that get summarized into confabulation). The tracker is
  the agent's own STRUCTURED state that survives compaction — reading it can't
  confabulate, and reading N tasks to report status is the behavior the gate
  wants. The gate was refusing tracker reads and telling the agent to "open a
  tracker project" while it was reading the tracker.
- FIX (this session): removed the three tracker read tools from `LOADING_TOOLS`
  (with a comment). External-source loading (file/web/exec/gmail/drive/etc.) still
  counts; tracker reads are free. The loop detector still catches a thrash of the
  SAME read. Verified: `isLoadingTool` now returns exempt for the three tracker
  reads and LOADING for file_read/web_fetch/exec/gmail_read.

## RESOLVED (was OPEN-3) — `send_to_agent` no longer thrash-gated for distinct messages
**Severity: medium. Caused by redesign: partially exposed (the A2A exemption only
covered A2A turns).**
- Symptom: on email/Teams user turns where the agent coordinated with the PM
  (`send_to_agent` to kelly), the loop detector tripped and returned "STOP — you
  have called `send_to_agent` N times…", blocking legitimate coordination.
- Root: `canonicalToolSignature` stripped `payload` as prose, so send_to_agent
  was keyed only by `{agent, thread_id, intent}`. Distinct messages on the same
  thread collapsed to one signature → 3 hit the repeat threshold → blocked. The
  existing exemption only covered A2A turns (counterparty.kind==='agent').
- FIX (this session): added a `COORDINATION_TOOLS` carve-out in
  `classifiers/loop.ts` (send_to_agent, broadcast_to_group) that KEEPS
  `payload`/`message` in the signature — same pattern as the SEARCH (`query`) and
  GENERATION (`description`) carve-outs. Now distinct messages = distinct
  operations (allowed, on user AND A2A turns); a true thrash (identical message
  re-sent) still collapses to one signature and is still caught. Verified:
  same-thread different-payload → distinct sigs; identical resend → same sig.
  More general + safer than a blanket exemption (real thrash is still detected).

## RESOLVED (was OPEN-4) — Thrash-gate breaker cascade (fixed by removing its feeders)
**Severity: medium. Caused by redesign: no.**
- Symptom: `v2: thrash gate breaker tripped — task auto-blocked` — a tracker task
  auto-blocked after the agent repeatedly hit gates without making "progress." The
  most user-visible "everything is erroring" symptom.
- Root: the breaker (`THRASH_GATE_BREAKER_LIMIT=6`) trips on
  `thrashGateRefusalCount`, which only accrues when the agent repeats an identical
  signature ≥4× (`DUPLICATE_SIG_LIMIT`) and keeps hitting the per-signature gate.
  Those false repeats were manufactured by OPEN-1/2/3: a rejected malformed
  `tracker_update_status` got retried with the same malformed signature → 4 repeats
  → gate → breaker; hoarding/loop false-refusals drove similar retry loops.
- FIX (this session): resolved by fixing the three feeders — OPEN-1 (repair
  malformed args so the completion call succeeds first time), OPEN-2 (tracker reads
  no longer hoarding-gated), OPEN-3 (distinct coordination messages no longer
  loop-blocked). The breaker LOGIC is intentionally unchanged — it is correct and
  should still catch GENUINE thrash (an agent truly re-issuing one identical call).
  No false-positive feeders remain in the audited paths.

## RESOLVED (was OPEN-5) — NOT a product bug: a dev-harness artifact; the real iMessage path already gates
**Severity: was logged as "needs policy ruling"; turned out to be a test-harness
artifact. Real product is correct. Caused by redesign: no.**
- Symptom: in `battery.mjs` the "iMessage from UNKNOWN number — expect SUPPRESSED"
  case produced an outbound iMessage to the unknown number ("…you may have the wrong
  number…"). The test label expected no auto-reply.
- ACTUAL ROOT (traced this session): the REAL iMessage bridge never lets an unknown
  sender through in the first place. `imessage-bridge.ts` polls the Messages DB with
  a query restricted to approved senders (`chat_identifier LIKE` each safe sender)
  and re-validates every row against `findSafeSenderByAddress`, DROPPING anything
  that isn't a real safe-sender match (`:782-854`). An unknown sender's message never
  reaches the agent → it cannot reply. Email/Teams/SMS likewise stamp
  `authorized:false` for unknowns → no reply. The agent already replies ONLY to
  safe senders on every channel — exactly the required security rule.
- Why the battery "failed": the DEV simulator route (`gateway/routes/dev.ts`)
  injected the fake unknown sender with `authorized:true` hardcoded, bypassing the
  bridge's real gate. So the battery exercised a state the real product never
  produces. The inbound_meta evidence above came from that dev injection, not a real
  inbound.
- DECISION (David, this session): no product change — "go back to the way it was."
  A surfacing-with-buttons feature was started then reverted (the bridge already
  filters unknowns out, so there's nothing to surface). The real fix is to the DEV
  HARNESS: the iMessage simulator should respect the safe-sender gate (not inject
  `authorized:true` for a non-safe sender), so the battery reflects reality. Logged
  for whoever maintains dev-test-tools; no engine/product code changes.

---

## RESOLVED (was OPEN-9) — Close-the-loop: just-in-time hint on contact turns
**Disposition (David, this session): "add a just-in-time hint."**
- FIX: `renderCounterpartyHeader` (counterparty.ts) now appends a close-the-loop
  reminder ONLY on non-owner human turns (relation !== 'owner') — "if your reply
  promises to follow up with <owner>, actually do it THIS turn (reminder or a note),
  a promise to a contact isn't kept until you act." Relevant-only (per-turn
  counterparty header, NOT always-on SOUL), framed as advice so the model keeps
  judgment. Verified: hint present on known_contact + third_party headers, absent on
  owner and agent headers. Best-effort by design — the engine can't reliably detect
  every "I'll do X" promise, so this nudges rather than enforces.
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

## RESOLVED (was OPEN-11) — Scheduler/engine turn runs a STALE already-answered user request (task hijack)
**VERIFIED on dev 2026-06-29:** scheduler fired a "post a coffee haiku" task with a stale, already-answered memory-rundown sitting in context → the agent wrote the haiku, not another rundown. Required a follow-up fix the typecheck missed and only the dev run caught: `scopeToEngineTurn` must drop a prior conversation's tool RESULTS (stamped conv_key), not just its text — copying the A2A scoper's "keep self tool activity" leaked the stale exec output and the model regenerated the rundown from it.
**Severity: HIGH (reliability). Caused by current work: YES (gap in the redesign's turn scoping).**
- Symptom (prod, 3.1.10-preflight.11, 2026-06-28): the scheduler fired a recurring
  task at 7:00:07 ("Run daily gastro email digest — scan Gmail, append to
  gastro-tracker.md"). Instead the agent ran a STALE, hour-old, already-answered
  "give me a RAM rundown" request — ran `ps`/`top`, texted the user a RAM report —
  and NEVER did the gastro task. The scheduler then reset the task (missed
  `tracker_update_status`).
- Root cause: a scheduler (engine) turn has no dedicated scoping lane or directive
  source. `runtime.handleMessage` ignores its content arg and calls `runV2Turn(agentId)`
  (`runtime.ts:436,452`), which rebuilds the trigger from the DB. `getWaitingHumanConversations`
  drops engine origins (`counterparty.ts:66`), so the scheduler turn has no waiting
  conversation → `resolveTurnCounterparty` synthesizes an OWNER/dashboard human
  counterparty from null content (`origin.ts:200-204`), `currentTurnKind` is set to
  `'user'` (`loop.ts:567`), and fresh-tail scoping (`assembler.ts:857-859`, only two
  branches: `'agent'`→A2A, else→human) takes `scopeToHumanConversation` against the
  owner tail — keeping the stale RAM request live. `getActiveUserDirective`
  (`directive.ts:36-81`) then re-pins the most-recent ≥200-char user message as the
  "ACTIVE USER DIRECTIVE" with NO origin filter and NO already-served filter, so the
  hour-old answered request out-competes the actual scheduled task (which is demoted
  to an EVENTS-lane bullet, `assembler.ts:879-908`).
- Fix direction: (a) give engine/scheduler turns a real lane — scope the tail to the
  triggering engine event and present the scheduler payload as the directive, mirror
  of `scopeToA2AThread`; (b) `getActiveUserDirective` must exclude `origin_kind='engine'`
  rows AND rows already served (their conv_key has a later own-reply) so an answered
  request can never be re-pinned as the active WHAT.

---

## RESOLVED (was OPEN-12) — Rapid same-sender inbound: middle message gets NO turn (silently absorbed)
**VERIFIED on dev 2026-06-29:** two rapid distinct iMessages (the 2nd landing mid-turn) — before: only the 1st answered, 2nd dropped; after: BOTH answered, oldest-first, agent idle (no thrash/double). ROOT fix (a first attempt was a patch — a "note" that only fired when both were waiting at one pickup): "served" is now per-message — a message is unanswered iff its OWN conv_key is NULL (claimed at pickup), not "a later reply exists." Trigger is the OLDEST unanswered message.
**Severity: HIGH (reliability). Caused by current work: YES (consequence of conv_key coalescing).**
- Symptom (prod, same session): user sent "Can you let Jain know the dates and times?"
  → ZERO agent activity (no thinking, no tool call, no reply). 4 min later user sent
  "Kevin?" → agent replied "I'm here. What's up?" with no memory of the request. The
  middle message never created a turn.
- Root cause: all inbound from one sender collapse to one conversation keyed by
  `channel:sender` (`counterparty.ts:100-105`). `getWaitingHumanConversations` keeps
  only the newest row as `.latest` (`counterparty.ts:69`); the loop triggers only
  `waitingConvs[0].latest` (`loop.ts:438`) and stamps conv_key on only that row
  (`loop.ts:455-460`). The served-check (`counterparty.ts:70-71`) then marks the WHOLE
  conversation answered once a reply lands after the newest rowid — so an earlier
  unanswered message is dropped from the waiting set forever. If the agent was mid-run
  when it arrived (`runtime.ts:438-442` sets pendingWakeups and returns), the message
  is persisted but its only trigger path is `.latest`, which a newer message displaces.
  (Persistence rule #2 is technically upheld — the loss is in turn-creation, not storage.)
- Fix direction: do not collapse distinct same-sender messages to a single trigger.
  Either re-trigger the drain per unanswered rowid, or feed ALL unanswered same-sender
  rows into the trigger turn (not just `.latest`); the served-check must not mark an
  OLDER unanswered message served because a reply landed after a NEWER one.

---

## RESOLVED (was OPEN-13) — Inbound iMessage live-vs-refetch attribution divergence
**VERIFIED on dev 2026-06-29 (with a framing correction):** the original "bubbles don't render" symptom was actually OPEN-12 (messages not getting persisted/turned), now fixed. The REAL OPEN-13 defect: the bridge's live `chat:message` broadcast omitted `inboundMeta`, so the central origin stamp marker-PARSED it (an owner iMessage classified as `relation=known_contact`) while HTTP refetch used structured meta (`relation=owner`) — a live-vs-refetch attribution divergence. Test confirmed: display TIER was already consistent (user-visible) for authorized iMessages, but RELATION diverged; the fix (broadcast now carries `inboundMeta`) makes both paths use the structured origin → owner stays owner.
**Severity: MEDIUM (visibility/auditability). Caused by current work: partially (origin asymmetry).**
- Symptom: two of the user's inbound iMessages reached the model (its thinking/replies
  reference them) but never rendered as inbound bubbles in the dashboard; only the 1st
  and 4th rendered. The user's "did you send to Jain?" question "never appeared in the chat."
- Root cause: the iMessage bridge's live `chat:message` broadcast omits `origin`/`source`
  (`imessage-bridge.ts:1043-1063`); the dashboard then reads `origin=undefined`
  (`Chat.tsx:1123`) and falls to the legacy content-marker display path
  (`visibility.ts:361-363`). Persisted rows get a server-derived `origin` via
  `deriveOrigin` on refetch, so the live broadcast and the HTTP/store path can disagree
  about visibility — and the non-rendered ones line up with the coalesced/non-latest
  messages from OPEN-12.
- Fix direction: run the just-inserted row through `deriveOrigin` and include
  `origin`+`source` in the bridge broadcast so live render and refetch agree. (Pairs
  with OPEN-12.)

---

## RESOLVED (detection-verified; was OPEN-14) — No claim-grounding guard: agent fabricates a completed action
**DETECTION VERIFIED on dev 2026-06-29; end-to-end firing NOT force-reproduced.** Deterministic 8-case test of `detectUngroundedDeliveryClaim` passes, including the exact failure text ("Sent it to Jain…", no tool → flagged), grounded case (same claim + `send_to_agent` → not flagged), and false-positive guards ("I emailed YOU", "I'll let Devi know" future, "sent Monday's notes"). The test caught a real gap in my own patterns — "texted Cory"/"emailed Tomas" (verb + name, no preposition) weren't matched; added a direct-object pattern for person-taking verbs. The loop hook is wired (mirrors the proven nudge-and-`continue` pattern) and produced NO false positives in two real relay scenarios (agent correctly asked for a missing number / actually called `send_to_agent`). CAVEAT: could not force a live confabulation to watch the re-enter fire — the model kept behaving correctly. Detection + wiring proven; firing path proven by construction, not by a forced live confab.
**Severity: HIGH (trust). Caused by current work: NO (pre-existing missing guard, newly exposed).**
- Symptom: agent texted "Already done. Sent it to Jain a minute ago: [flight details].
  All set." with NO `send_to_agent`/A2A/message tool call anywhere in the turn. Same
  class: a RAM report that stitched fresh memory totals onto an hour-old process table.
- Root cause: nothing in the engine cross-checks a user-facing past-tense action claim
  ("sent/texted/emailed/created/scheduled X") against the tool calls that actually fired
  this turn. `outputPersistenceClassifier` (`output.ts:95-118`) only decides
  persist-vs-suppress; `isGenericCloseout` (`output.ts:136-141`) only trims a short
  "Done." on continuations; the close-the-loop hint (`counterparty.ts:196-201`) fires
  ONLY on non-owner turns and only nudges about FUTURE promises, not past-tense
  completion claims — and the failure was on an OWNER turn.
- Fix direction: a post-response grounding classifier that runs before persistence —
  detect past-tense action claims and verify a matching tool-call family fired this turn;
  on mismatch, inject a one-shot system correction and re-enter the loop (mirror the
  missed-reply nudge at `loop.ts:3163`) so the agent actually does it or corrects the
  claim. Must fire on owner turns too. This is engine enforcement of "every claimed
  action has a tool call behind it" (consistent with invariant #1, and the
  preserve-the-reason / no-suppression laws — fix the cause, don't hide the text).

---

## RESOLVED (was OPEN-15) — `recall_recent_thread` bleeds unrelated cross-task output into a conversation
**VERIFIED on dev 2026-06-29:** seeded an agent with two conversations + a cross-conversation tool result; `recall_recent_thread` with default `scope:'conversation'` (current = owner) returned only the owner conversation and EXCLUDED the other conversation's messages and its tool output (the apt/dnsmasq-style leak); `scope:'all'` returned everything. Conversation key is derived from the most-recently-stamped conv_key in session.
**Severity: MEDIUM. Caused by current work: NO (pre-existing coarse scope).**
- Symptom: while answering "Did you get John's flight info?", `recall_recent_thread`
  returned unrelated `apt autoremove … dnsmasq … opennds-daemon` output from a different
  task in the same session.
- Root cause: `recallRecentThread` (`recall.ts:175-396`) scopes its query only by
  `agent_id` + `session_started_at` + role (`recall.ts:212-232`) — no conv_key, thread,
  or task filter. It returns the raw last-N messages across every interleaved
  conversation/task on the agent's single stream.
- Fix direction: pass the turn's conv_key/counterparty into `RecallOptions` and default
  to conversation-scoped recall, with an explicit opt-out param for the genuine
  post-compaction "show me everything" recovery case. Tool rows aren't conv-tagged today,
  so scope by the matching conversation's user/assistant turn boundaries.

---

## RESOLVED (was OPEN-16) — Anti-hoarding gate false-positives on routine multi-source lookups
**VERIFIED on dev 2026-06-29 (root-cause, not a threshold bump):** a first attempt raised the threshold 6→8 — reverted as a patch ("raise the bar to mask"). REAL cause: FAILED loading calls counted. A multi-account `outlook_search` that errored and retried padded the count with calls that loaded nothing. Fix: failed loads decrement the count (loop.ts), `recall_recent_thread` exempted, threshold stays 6. `isLoadingTool` test passes 7/7 (recall/contact_search/load_tool_docs exempt; outlook/gmail/vault/exec counted). Recounting the exact original failure: net 3 (was 6) → gate no longer fires.
**Severity: MEDIUM. Caused by current work: NO (pre-existing gate design).**
- Symptom: a trivial "did I get an email from John?" check made 6 read-only calls
  (vault_search, contact_search, recall_recent_thread, load_tool_docs, outlook_search,
  gmail_search) and the gate REFUSED further searches, demanding `tracker_create_project`
  — degrading the answer.
- Root cause: `LOADING_GATE_THRESHOLD = 6` (`hoarding.ts:27`) fires on raw count of
  LOADING_TOOLS with no deliverable signal; there is no exemption for cheap read-only
  orientation tools (`contact_search`, `recall_recent_thread`, `load_tool_docs`), and
  none of the lookup tools is a STRUCTURING_TOOL, so a normal lookup can never satisfy
  the gate. The gate's intent is corpus-synthesis-with-a-deliverable, but its firing
  signal is count-only.
- Fix direction: exempt read-only orientation tools from the count (mirror the existing
  tracker-read carve-out, `hoarding.ts:53-62`), and/or gate on deliverable-intent
  (token-weighted volume or presence of draft/deliverable text) rather than raw call
  count. Raising the constant alone is the weakest fix.

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
