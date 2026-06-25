# Message Attribution Redesign — "Every message knows who it's from"

**Status:** Design proposal (not yet approved, nothing implemented)
**Author:** drafted from a top-down research pass across loop, model calls, prompt injection, channels, multi-agent, engine messaging, storage, and visibility.
**Goal:** Make it structurally impossible for an agent to confuse who said what. Every message the model sees carries explicit, structured attribution (who + what relationship + what channel). The model is never shown two senders' live messages mixed together. The result deletes the blockers, filters, regex markers, and per-turn hacks that exist today (including the ones added in the last few days) because they are no longer needed.

---

## 0. Non-negotiable invariants (must not regress)

These already work and a lot of effort went into them. The redesign must **strengthen** them, never break them. Each is a required regression test that must pass at every phase before that phase is considered done:

1. **Channel distinction.** The agent always knows whether a message came over iMessage, dashboard chat, email (Gmail/Outlook), Teams, SMS, phone/voice, or A2A — and who the sender is.
2. **Reply routing stays on-channel.** A message received on iMessage is answered on iMessage; dashboard → dashboard; email → email reply; Teams → Teams; SMS → SMS; phone → spoken; A2A → send_to_agent. Replies never cross channels. (This is exactly what `resolveInbound` + `state.inboundChannel/inboundContext` → end-of-turn reply routing does today; the redesign keeps that path and feeds it the same/stronger structured data.)
3. **Sender authorization.** "The user themselves" vs "a friend on the safe-sender list" vs "an unknown sender" is preserved; the agent does not act on an unauthorized sender's behalf.

Working agreement: **build everything on the dev server, commit nothing until David approves, test exhaustively** (including the channel-routing regression above) at every step.

## 1. The disease (one sentence)

Every inbound — the user on dashboard, the user on iMessage, the user's friend on iMessage, another agent over A2A, the PM, the scheduler, the tracker, the healer, the rate-limiter — is stored and rendered to the model as **`role: 'user'`** (or `'system'`), distinguished **only by a text marker inside the content** (`[SOURCE: …]`, `[A2A: …]`, `[Engine …]`, `═══ … ═══`). A weak model cannot reliably parse ~30 different markers interleaved in one stream, so it collapses them into one mental counterparty: *"someone is asking me several things."*

The evidence: the model's own reasoning — *"Kelly is asking me two things… 'freezing point of water' — this might be part of Kelly's message or the active user directive bleeding through."* Two different people, one perceived sender.

---

## 2. What already exists (we are not starting from zero)

The `messages` table already has structured attribution columns; the assembler just doesn't use them when building the model's view:

| Column | Added | Carries | Used by model context today? |
|---|---|---|---|
| `role` | base | user/assistant/system/tool | yes (but only 2–3 roles reach the API) |
| `source_agent_id` | mig 027 | which agent SENT an A2A | no (not mapped in `rowToMessage`) |
| `a2a_thread_id` | mig 034 | A2A thread | no |
| `a2a_intent` | mig 034 | QUESTION/ASSIGN/ANSWER/… | no |
| `a2a_requires_response` | mig 034 | wake semantics | no |
| `source` | mig 046 | `'voice' | 'a2a' | null` | partially (voice routing, A2A display) |
| `inbound_meta` (JSON) | mig 073 | `{channel, accountKind, authorized, sender, recipient, …}` | only for reply-routing, not shown to model |
| `turn_number`, `reasoning_content`, `attachments` | 037/040/011 | — | yes |

**Key finding:** `store.ts:rowToMessage` does `SELECT *` but maps only the base columns. `source_agent_id`, `a2a_thread_id`, `a2a_intent`, `a2a_requires_response`, `inbound_meta` are **read from the DB and thrown away** before the model ever sees them. The attribution exists; it's discarded at the seam.

**Gaps in the existing structured data:**
- iMessage and dashboard do **not** stamp `inbound_meta` (iMessage uses an in-memory map; dashboard relies on `source`/null). So two of the most common channels lack structured channel+sender.
- There is no single field for "relationship of sender to the user" (self / known-contact / third-party / agent / engine). It's implied by safe-sender `is_primary` flags and `accountKind`, scattered per channel.
- ~30 engine-injected message types (scheduler, tracker, healer, rate-limit, budget, sub-agent completion, nudges, etc.) carry **no** structured origin at all — pure text markers.

---

## 3. The principle: three lanes, one counterparty per turn

Everything in an agent's context is exactly one of three things. Today all three masquerade as `role='user'`. The redesign gives each a distinct, consistent representation and never lets them impersonate each other.

- **Lane 1 — The conversation.** Live back-and-forth with the **current counterparty** (the human on a channel, or one agent). Real user/assistant alternation. Scoped to **one** counterparty per turn.
- **Lane 2 — The agent's own mind.** Identity (SOUL), memory (vault), summaries, scratchpad, briefing, knowledge, tools. The agent's knowledge of the world and itself. Framed as "what you know," never as a message from anyone.
- **Lane 3 — Engine events.** Tracker assignments, scheduler fires, healer alerts, rate-limit notices, sub-agent completions, A2A from agents who are *not* the current counterparty, system notices. Framed as **events that happened**, never as a human talking.

**Two invariants that kill the confusion:**
1. **One counterparty per turn.** The live conversation (Lane 1) contains exactly one sender. The turn opens by naming them: *"This turn you are responding to **David (your primary user)** over **iMessage**."* A2A from Kelly while you're talking to David is a Lane-3 event (and gets its own turn to answer). David's question never sits next to Kelly's in Lane 1.
2. **Lanes never impersonate each other.** Memory and engine events are never `role='user'` human-shaped messages interleaved into the live tail. They live in clearly-delimited, consistently-formatted blocks. The "active user directive bleeding through" bug dies here: the directive is Lane 2 (your knowledge of the current goal), not a peer message floating next to the live chat.

The asymmetry that resolves the earlier accuracy worry: **Lane 1 is one counterparty; Lanes 2 and 3 are always available.** When Kelly asks "what's the budget," the agent answers from Lane 2 (its project memory: the file it wrote, the tracker, vault, summaries) — not from David's raw Lane-1 messages. Proven already: in testing, the agent answered an A2A accurately by reading its own project file, not the user conversation.

---

## 4. Target architecture

### 4.1 A canonical `MessageOrigin` (consolidate the scattered fields)

One structured descriptor every message carries and every layer reads:

```ts
type OriginKind = 'user' | 'agent' | 'engine' | 'self';
//  user  = a human (the owner OR a third party) on some channel
//  agent = another agent (A2A)
//  engine= the platform itself (tracker/scheduler/healer/system/nudges)
//  self  = this agent's own prior output

type Relation = 'owner' | 'known_contact' | 'third_party' | 'agent' | 'engine';

interface MessageOrigin {
  kind: OriginKind;
  relation: Relation;        // owner vs friend vs unknown vs agent vs engine
  channel: Channel | null;   // dashboard | imessage | teams | sms | email | phone | voice | a2a | engine
  senderName: string | null; // "David", "Kelly", "Crystal", "+1555…"
  senderId: string | null;   // agent id, safe-sender id, address
  threadId: string | null;   // a2a thread, email thread, chat id
  intent: string | null;     // a2a intent or engine event type (tracker.assigned, scheduler.fire, …)
  authorized: boolean;       // may the agent act/reply on this sender's behalf
}
```

This is not new storage so much as a **projection** over columns that already exist (`source`, `source_agent_id`, `a2a_*`, `inbound_meta`) plus a backfill for the gaps (iMessage/dashboard `inbound_meta`, engine-event typing). One function, `originOf(messageRow): MessageOrigin`, becomes the single source of truth, with a read-time shim that parses legacy text markers for old rows so we don't need a destructive migration.

### 4.2 The turn opens by declaring its counterparty

Replace the scattered `triggerRow` / `resolveInbound` / `isA2ATurn` logic (loop.ts ~404–528) with one step that produces a **TurnCounterparty**:

```
This turn's counterparty: David — your primary user — speaking over iMessage.
(Reply goes back to iMessage. Everything below marked EVENT or MEMORY is context, not David talking.)
```

For an agent turn:
```
This turn's counterparty: Kelly — the PM agent — over A2A, thread a1b2 (intent: QUESTION).
Reply with send_to_agent on thread a1b2. David is not part of this exchange.
```

This single, structured, always-present header is what the model anchors on. It is generated from `MessageOrigin`, not from prose parsing.

### 4.3 The live conversation (Lane 1) is scoped to the counterparty

The fresh-tail query (`store.ts:getRecentMessages`, used by `assembler.ts`) gains a counterparty filter:
- **Human turn:** messages whose origin is the same human+channel conversation (today: `a2a_thread_id IS NULL AND` engine markers excluded). Pure human↔agent alternation.
- **Agent turn:** messages on that `a2a_thread_id` only.

No A2A in a human turn. No human chat in an agent turn. No engine events interleaved in either. This is the structural replacement for the current "strip A2A on user turns" filter — done at the query, by attribution, not by regex after the fact.

### 4.4 Lane 2 + Lane 3 render as clearly-delimited context, never as peer messages

Today the assembler pushes ~15 scaffolding blocks and ~12 engine markers into the messages array as `role='user'`, interleaved with the live tail. Redesign: collect them into a **single, structured context envelope** placed before the live conversation, with stable section headers the model is taught once:

```
=== YOUR MEMORY (not messages — what you know) ===
  · Identity / standing prefs
  · Current goal (the "active directive" — your objective, not a message)
  · Scratchpad, briefing, relevant vault, summaries
=== EVENTS SINCE YOU LAST ACTED (things that happened — not people talking) ===
  · [tracker] You were assigned "Plan offsite" (task 3f2a)
  · [scheduler] Daily digest task fired
  · [agent: Kelly] asked on thread a1b2: "status?"  (answer on its own turn)
=== CONVERSATION (this is <counterparty> talking to you) ===
  (the live tail — one counterparty)
```

One convention. The model learns "MEMORY = what I know, EVENTS = things that happened, CONVERSATION = the person I'm replying to." This replaces ~30 bespoke markers with three categories.

### 4.5 The model call carries the counterparty explicitly

`ModelCallParams` (model.ts:23) gains `counterparty: TurnCounterparty`. The Anthropic 2-role constraint is unchanged — attribution rides in the structured header + the three-lane framing, which is consistent and documented, not ad-hoc. (We are not inventing API roles; we are making the *content* unambiguous and uniform.)

---

## 5. Subsystem-by-subsystem impact

### 5.1 Storage & schema (`db/migrations`, `store.ts`, shared `types.ts`)
- **Backfill `inbound_meta` for iMessage + dashboard** so every inbound has `{channel, sender, relation, authorized}` (imessage-bridge.ts persist path; chat.ts dashboard submit). Removes the last prose-only channels.
- **Type engine events:** add `origin_kind` + `origin_intent` (or reuse `source` + a new `event_type`) so tracker/scheduler/healer/etc. inserts carry structured origin instead of `[SOURCE: …]` text. ~30 insert sites (enumerated in research) get a structured origin instead of a hand-built marker string.
- **`rowToMessage` maps ALL attribution columns** (currently drops 5). Surface them on the shared `Message` type.
- `originOf(row)` projection + legacy-marker read-shim for pre-migration rows. **No destructive migration**; old rows resolve via the shim.

### 5.2 Inbound channels (`inbound-channel.ts`, watchers, bridges)
- `resolveInbound` already centralizes channel resolution (3-tier: voice → `inbound_meta` → prose). Make `inbound_meta` mandatory for all channels (close the iMessage/dashboard gap) so the prose tier becomes legacy-only (kept for old rows via the shim, deleted later).
- Derive `relation` once: owner (is_primary / authenticated account) vs known_contact (safe-sender) vs third_party (unknown) vs agent. This is the "the user vs the user's friend" distinction the model needs, computed once and stored, not re-derived from prose.

### 5.3 The loop (`runtime.ts`, `v2/loop.ts`, `v2/state.ts`)
- Replace `triggerRow` query + `lastUserMessageContent` + `latestUserSource` + `isA2ATurn`/`forceA2ATurn`/`unansweredUser`/`mostRecentIsA2A` (loop.ts ~404–528, the whole tangle I recently added) with **one** `resolveTurnCounterparty(agentId)` returning `{ counterparty: MessageOrigin, channel, replyTarget }`.
- `state.ts` carries `counterparty` immutably for the turn (replaces `triggeredByIMessage`, `triggeredByA2AReplyIntent`, `inboundChannel`, `inboundContext`).
- Turn routing (which counterparty's turn runs when several are waiting) stays on the existing wakeup/serialization machinery (handleMessage/activeRuns/pendingWakeups) — but "what is this turn about" is now a clean counterparty resolve, not a 120-line heuristic.

### 5.4 Context assembly & prompt (`memory/assembler.ts`, `prompt/assembler.ts`, `prompt/registry/*`)
- Fresh tail scoped by counterparty (5.3).
- The ~15 scaffolding blocks → the **MEMORY** envelope (Lane 2). They already exist; they get one consistent frame instead of 15 `═══` headers masquerading as user messages.
- The ~12 in-tail engine markers + the ~30 engine-injected message types → the **EVENTS** envelope (Lane 3), rendered from structured origin.
- The turn header (4.2) is a new, always-present system section generated from the counterparty.
- `sys.message-sources` (the [SOURCE:…] taxonomy the model must memorize) shrinks to documenting the **three lanes** once.

### 5.5 Multi-agent / A2A (`a2a-transport.ts`, `a2a-replies.ts`, `tools.ts`)
- A2A inbound is just `origin.kind='agent'`. When it's the current counterparty → Lane 1 (its thread). When it isn't → Lane 3 event + its own queued turn.
- The A2A reply enforcer, the `a2a_replies` durable tracking, preemption/wakeup all stay — but the "is this an A2A turn / did A2A bleed into a user turn" guesswork disappears because the counterparty is explicit.
- Group/squad threads = a multi-party Lane 1: here (and only here) each message keeps a consistent `senderName` tag, because there genuinely are multiple counterparties. This is the one place per-message tagging is correct, and it uses the same `MessageOrigin`.

### 5.6 Engine messaging (scheduler, tracker, healer, rate-limit, budget, spawner, model-switch, session-reset…)
- All ~30 enumerated insert sites stop hand-writing `[SOURCE: …]` / `[System: …]` strings and instead persist with a structured `origin` (kind='engine', intent='tracker.assigned' etc.).
- The assembler renders them uniformly in the EVENTS lane. Wake semantics (does this event trigger a turn) stay as-is.

### 5.7 Visibility / dashboard (`shared/visibility.ts`, dashboard `Chat.tsx`)
- `classifyMessageForDisplay` becomes **purely structured** (read `origin`), deleting the regex/prefix lists. A2A/engine/agent-only vs user-visible falls straight out of `origin.kind`/`relation`.
- The dashboard already consumes `source`; it consumes `origin` the same way. This subsumes the `source='a2a'` display hack I just added.

### 5.8 Model layer (`model.ts`)
- `counterparty` added to params; providers unchanged (still 2-role). Role mapping (tool→user) unchanged.

---

## 6. What this DELETES (the elegance payoff)

This is the point — fewer moving parts, not more:

- **My recent band-aids, all removed:** the fresh-tail A2A strip, the A2A-turn salience reorder, the `forceA2ATurn`/`a2aTurnRetries`/`lastTurnWasA2A` re-trigger machinery, the `interAgentTurn` output suppression, the `source='a2a'` display tag, the enforcer gating. They were compensating for mixed senders; with one counterparty per turn they're unnecessary.
- **The prose marker taxonomy** (`HIDDEN_USER_CONTENT_PREFIXES`, `ENGINE_INJECTION_PREFIXES`, `ASSISTANT_FALLBACK_PREFIXES`, the `[SOURCE: …]` zoo) → replaced by structured `origin`. Kept only inside the read-shim for legacy rows, then retired.
- **The `triggerRow` exclusion filters** and the `isA2ATurn` heuristic cluster in loop.ts → one counterparty resolve.
- **The "model must parse [SOURCE:…]" system-prompt section** → "three lanes" explanation.
- **Content-based visibility regex** → structured classification.

Net: ~30 ad-hoc markers and ~6 turn-classification hacks collapse into one `MessageOrigin` + one turn header + three rendering lanes.

---

## 7. Migration & backward compatibility

- **No destructive migration.** New columns are additive; `originOf()` has a read-time shim that maps legacy text markers → structured origin for rows written before the change. Old conversations render correctly.
- **Backfill job (optional, online):** walk historical rows, parse markers, populate the structured columns so the shim can eventually be deleted.
- **Phase the writers before the readers:** start stamping structured origin on new inserts first; the assembler keeps reading both until backfill confidence is high.

---

## 8. Phasing (incremental, each phase shippable & testable)

1. **Foundation (no behavior change):** `MessageOrigin` type, `originOf()` + legacy shim, `rowToMessage` maps all columns, surface on `Message`. Pure plumbing; verify identical output.
2. **Close the channel gaps:** stamp `inbound_meta` for iMessage + dashboard; compute `relation` once. Verify every inbound has structured channel+sender.
3. **Counterparty resolve:** introduce `resolveTurnCounterparty`, thread into state; keep old rendering. Verify the header matches reality across all channels + A2A.
4. **Lane 1 scoping:** scope the fresh tail by counterparty. This alone kills the cross-sender confusion. Delete the A2A strip + isA2ATurn hacks. Heavy testing here (the dev harness already exercises this).
5. **Lanes 2 & 3 framing:** move scaffolding → MEMORY envelope, engine messages → EVENTS envelope, structured rendering. Delete the marker zoo. Retire the band-aids.
6. **Visibility structured:** flip `classifyMessageForDisplay` to `origin`-based; delete regex. Dashboard parity check.
7. **Cleanup:** delete legacy prose paths once backfill is done.

Each phase is independently verifiable on the dev server with real, multi-sender scenarios (user-on-dashboard + user-on-iMessage + a friend + an agent, simultaneously) — reading the **actual** assembled context and the **actual** dashboard classifier, not greps.

---

## 9. Risks & edge cases (anticipate, don't discover)

- **Recent unrecorded detail on an agent turn:** Kelly asks about something David said seconds ago, before it's in memory. Mitigation: a short "recent activity" item in the EVENTS lane (summary, not raw Lane-1 messages) so the gist is available without reintroducing sender mixing.
- **Group/squad threads:** genuinely multi-party. Handled as multi-party Lane 1 with consistent per-message `senderName` (the one correct use of per-message tags).
- **Channel switch mid-conversation** (user moves dashboard→iMessage): each is its own counterparty/channel; the turn header states the current one; continuity comes from memory, not from merging the two live tails.
- **Prompt-cache churn:** the turn header is volatile (per counterparty). Place it where today's volatile per-turn content goes (after the cached prefix, like `msg.current-time`) so we don't break caching.
- **The owner on two channels at once:** still one counterparty *per turn* (owner-via-dashboard ≠ owner-via-iMessage as live tails), but both are clearly the owner; the EVENTS lane can note "you also have an unread iMessage from David" so the agent isn't blind to it.
- **Legacy rows / mid-migration:** the read-shim guarantees old rows and in-flight messages still attribute correctly.
- **Tool results:** unchanged (role tool→user, agent-only); they're part of Lane 1's mechanics, attribution `self`.

---

## 10. Decisions (resolved with David, 2026-06-24)

1. **Scope:** build all phases, incrementally, each independently testable. Phase 4 fixes the reported confusion; 5–7 are the cleanup/elegance payoff. Do all of it.
2. **`relation` vocabulary:** `owner / known_contact / third_party / agent / engine`. Approved.
3. **Owner on two channels:** owner-via-dashboard and owner-via-iMessage are **two distinct conversations**, bridged by memory. This is what preserves on-channel reply routing (Invariant 2).
4. **Backfill:** handled automatically via the read-time shim; a historical backfill is optional and can run later. Not a blocker.
5. **Where it rides:** **dev server only.** Nothing is committed until David approves after exhaustive testing. No Stable/Preflight decision needed yet.
