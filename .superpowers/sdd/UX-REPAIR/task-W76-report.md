# W76 — UX-ACCESS PHASE A4 (prompt truth · techniques wired · the last unwalled doors · the exemplars)

Branch `ux-access-a4` from `ux-access-a3` (`ac945a99`). Nothing pushed, no cut.

| commit | what |
|---|---|
| `eb0c7846` | UX-ACCESS A4: prompt truth from grants, techniques wired, the last unwalled doors |
| `68aaf10a` | gate-side: thirteen ratchet pins, two files admitted |
| `0f0eda88` | UX-ACCESS A4 rider: the me-vs-others tier gets its first reader, above the transport |
| `753726db` | gate-side: `comms.ts` raised, `access/read.ts` admitted |

---

## 1. VERDICTS

| gate | result |
|---|---|
| server unit suite | **384 files / 5552 tests green** (A3: 381 / 5482 — +3 files, +70 tests) |
| `npm run typecheck` (shared + server) | **exit 0** |
| `npm run lint` | **0 errors**, 104 warnings = the pinned baseline exactly |
| `npm run build` (shared + server + dashboard) | **green** |
| `npm run gates:block` | **13/13 blocking gates green** |
| `npm run gates:report` | capability-ledger + deletion-ratio red — **the same two A1, A2 and A3 recorded** (§9) |
| kit roster (`check-roster-conformance.mjs`) | **conformant** — 9 checkers, all named |
| kit prompt-gate roster | **8/8 exit 0 at `68aaf10a`**, record accepted by `check-prompt-gate-record.mjs`. **6/8 at `753726db`** — the two reds are the box's Plaud connection expiring mid-task, proven in §7 and deliberately **not** re-blessed |

---

## 2. THE PROMPT, MEASURED RATHER THAN CLAIMED

**THE PRIMARY'S PROMPT DOES NOT MOVE. 105 OTHER AGENTS' PROMPTS SHRINK BY
EXACTLY 391 BYTES EACH. NOTHING GREW.**

The instrument is a prompt probe run in a worktree at `ac945a99` and in this
tree, against the SAME database copy, rendering the whole registry system prompt
for every agent and hashing it:

```
agents             : 111
prompt UNCHANGED   : 6   [dreamer, healer, imaginer, kelly, kevin, ticky]
prompt MOVED       : 105
prompt GREW        : 0
per-agent removal  : [391]      ← one value, not a distribution
total bytes removed: 41,055
SLOT ROSTER moved  : 0
kevin sha (base/A4): 293dffe37828ab35 / 293dffe37828ab35
```

The per-agent delta is the same three things every time, and every one of them
was a false claim:

```
- **Communication:** `show_to_user`, `imessage_send`, `imessage_list_contacts`, …
+ **Communication:** `show_to_user`, `share_publicly`, `share_file`, `add_safe_sender`
- **Twilio (SMS + Voice phone calls):** `sms_send`, `voice_call`, `voice_call_end`, `voice_call_status`
- ## iMessage
- `imessage_send` texts David via iMessage. If the bridge is off it fails loudly; …
```

**`check-cache-prefix` was green with no `--update` at `68aaf10a`** — prefix
byte-invariant across 9 turn-states, compared-region sha256
`98864a0aa32bcf6b…`, **the same value A2 and A3 shipped** — and that run
contained every prompt-affecting line A4 ships. **No re-bless of the cache
golden was needed or taken. The cache tenet holds.**

**One golden WAS re-blessed, and it is nine leaves of one field.**
`check-assembled-context`'s golden drives a FIXTURE sub-agent, which is one of
the 105. Captured before and after and diffed leaf by leaf:

```
changed leaves: 9        all of them: systemPromptChars
  .cells.baseline.assembly.systemPromptChars                 28680 -> 28289
  .cells.voice turn … .text turn … .voice + local TTS …      28680 -> 28289
  .cells.voice + cloud TTS … .othersWaiting … .conversational turn
  .cells.non-owner counterparty … .agent counterparty        28680 -> 28289
```

−391, in all nine cells, matching the independently measured per-agent number
exactly. Every message cell, every sha, every lane and every entry id unchanged.
**That is the whole re-bless register for A4.**

---

## 3. WHAT LANDED

### 3.1 Prompt truth (scope item 1) — the `can_spawn_agents` pattern, both halves

A1 §6.5 handed this here in writing: *"Stripping it by grant would move ~110
agents' tool indexes — a prompt change A1 is committed to not making. A4 owns
prompt/capability truth."*

**THE SURFACE.** A `SEND_TO_PEOPLE` tool whose channel is not granted leaves
`getFilteredTools`. Measured at `ac945a99` before any code was written: **105 of
111 agents were advertised exactly six tools they hold no grant for** —
`imessage_send`, `imessage_list_contacts`, `sms_send`, `voice_call`,
`voice_call_end`, `voice_call_status` — and every one of the six is refused for
those agents at a door that already reads `mayUseChannel` (ladder row 7 for the
two iMessage names, the `cat/comms.ts` handler walls for the other four). The
strip removes ADVERTISEMENT and never CAPABILITY, and the test walks that rather
than asserting it about six remembered names.

Because `generateToolsGuidance_v2`'s per-tool blocks are keyed on the advertised
list, the `## iMessage` paragraph stops being emitted **with no second rule
written anywhere** — which is the property the test pins, so a later
`mayUseChannel` check inside the guidance would be caught as a second authority.

**THE SOUL.** `applySpawnCapabilityTruth`'s one hard-coded line becomes
`SOUL_CAPABILITY_CLAIMS`, a register of exact shipped bytes and the door that
answers each. T3's spawn line is entry one, unchanged. The census found
*"You can execute shell commands."* unconditional in the same `## Capabilities`
list while the executor refuses it at row 3 for any agent with an empty
`exec_allow` — A1 §4 drove exactly that refusal while the soul went on claiming
the capability. Three properties, each a test: exact shipped bytes, **identity
for a holder** (so a prefix byte can only ever move for an agent the claim was
FALSE for), and absence-is-not-evidence (#15).

### 3.2 Techniques become a real grant section (scope item 2)

The census finding that shaped it: `agents.equipped_techniques` is a PRE-LOAD
list and was never an allow-list. `checkTechniqueAccess` took
`(technique, agentGroupId)` and answered *"published ⇒ everybody"*, in the
file's own words.

`AccessGrants.techniques` is the fourth section, wired at **all four seams** a
technique reaches an agent through — miss one and it leaks through a different
hole:

| # | seam | before | after |
|---|---|---|---|
| 1 | the published INDEX | `render: () => generateTechniqueIndex()` — the one place a filter could attach threw the agent id away | takes `ctx.agentId`, filtered to the grant |
| 2 | the MATCHER | `listTechniques({state:'published'})` — every technique, every non-PM agent, and a strong match inlines the whole body UNASKED and records usage | candidate set filtered by the same predicate |
| 3 | the DOOR | state + squad, no agent id | grant asked FIRST, then the state rule byte-identical |
| 4 | the EQUIPPED pre-load | four unvalidated write paths feed it | an ungranted id loads nothing |

`list_techniques` narrows to match the door. `executeUseTechnique`'s
hand-inlined COPY of the door folds onto the function — a second copy of a door
is a second place for the grant to be missing.

**The migration is the optional key.** The section is optional on the wire and
an absent one reads `'*'` (`techniqueGrantOf`), so A1's 111 materialized rows
keep their meaning **with no row rewritten and no DDL** — re-read on the live
box at the end of this task, `techniques` is NULL on all 113 rows and every one
answers `'*'`.

### 3.3 The last unwalled doors (scope item 3)

`agent/access/engine-route.ts` is the one predicate all of them ask.

| site | transport | before |
|---|---|---|
| `channel-push.ts` — five auto-route arms | bridge · Twilio · live call · `executeTool` | ungated (Teams/email gated only ACCIDENTALLY, because their arms synthesize a tool call) |
| `turn-closures.ts` — four engine-ack arms | same | same |
| `CallSession.queueAgentSay` — five callers | live call | ungated; **two of the five reach the caller MID-TURN**, ahead of every end-of-turn arm |
| `cat/media.ts` — the `image_create` attachment | bridge | `isPrimaryAgent` — the last outbound-to-human door on the role singleton |

ONE guard per file, not one per arm. Position is load-bearing in both and the
comments say why: in `channel-push.ts` **after** the settled-context hold, so a
turn already being held keeps its own recorded reason; in `turn-closures.ts`
**below** the persist+broadcast, so a withheld push costs the channel hop and
never the line. The refusal is a `held` ledger row with its reason, never a
silent drop.

Four predicate properties are tests because each is a bug that would otherwise
be silent: `'phone'` (routing union) must map to `'voice'` (grant union) or the
guard never fires for a live call; `'dashboard'` must answer "no opinion" or a
narrowed agent goes MUTE; `'a2a'`/`'engine'` must acquire no opinion either; and
the über toggle governs, because `channelTierOf` governs the reader.

### 3.4 The rider — the tier gets its first reader (§6 found it)

Owner ruling 1 asks for *"granular per-channel grants (and me-vs-other-people
tiers)"*. A1 declared `ChannelTier`, A2 taught `grantExcesses` to compare it, A3
drew it in the panel — and **`mayReachOthersOn` had ZERO callers whole-tree**. A
declared field with no reader is the disease this overhaul exists to cure, and
the field with no reader was the one carrying the owner's own exemplar.

And the exemplar drive found a second defect the first exposed: the
bridge-state check was the handler's FIRST statement, so with the bridge off
*"iMessage the owner"* and *"iMessage someone else"* came back **identical** —
the tier could not be observed to work at all, and an agent that was NOT
PERMITTED to reach that person was handed guidance to reach them on SMS instead.
**A fact about the BOX was masking a fact about PERMISSION.** The transport
check now sits below the recipient resolution and the permission checks; nothing
between them reads bridge state, so it is an ordering change and not a rewrite,
and its cost is stated in the file rather than hidden.

### 3.5 The panel

The Techniques section becomes two honest halves: the **GRANT** (may run — the
index, the matcher, the door), saved with the panel, and the **PRE-LOAD**
(equipping), which saves on change as it always did. The grant list gates the
equip list on screen exactly as the renderer gates it on the server, because
equipping something ungranted loads nothing and a control that offers it lies to
the owner.

---

## 4. THE 111-AGENT DIFF PROBE — FOUR SECTIONS, SO THE CLAIM IS EXACT

Run in a worktree at `ac945a99` and in this tree, against the same database
copy, with the new module imported OPTIONALLY so the base tree answers for
itself. Split into sections on purpose: a dimension A4 DELIBERATELY moves must
be diffed apart from the ones that must not.

```
S1  effective capability .............................. 8,436 lines   0 DIFFS
S2  advertised surface .................................. 111 lines   105 agents narrowed
S3  stored grants text ................................... 111 lines   0 DIFFS
S4  the new dimensions (absent at base) ................... —          reported, not diffed
```

**S1 is the load-bearing one and it is EMPTY.** Per agent: the executor deny
set, five channel predicates and tiers, Plaud, the credential grant and a
verdict per each of 15 stored credentials, both providers × both account kinds ×
widest, eight Workspace read/write verdicts, and **every declared gate's row,
kind, verdict, rule label, refusal message, errorCode, resource and audit name
across 26 calls**. Not one byte moved.

**S2, enumerated exactly** — and 0 agents gained anything:

```
agents with REMOVED tools: 105
agents with ADDED tools  : 0
  x105 [imessage_list_contacts, imessage_send, sms_send, voice_call, voice_call_end, voice_call_status]
```

**S3 is empty: the owner's stored rows were not rewritten.** The technique
migration is a reader rule, not a backfill.

**S4, the two new dimensions, measured over all 111:**

```
engine-route   dashboard=true  x111      ← nobody goes mute
               imessage/sms/phone/email/teams  true x1 (kevin), false x110
tier           mayReachOthersOn true x1 (kevin), false x110, on all five channels
techniques     '*' for all 111           ← the technique gate refuses nobody alive
```

**WHAT S1 DOES NOT COVER, stated rather than left implied.** It drives DECLARED
gates and access PREDICATES. Two A4 changes live in handler bodies and are
therefore invisible to it, and both are reported here instead: the tier wall
(new; its predicate is in S4 and is `false` for the 110 that were already
refused every channel) and the `comms.ts` ordering move, whose behaviour delta
is named in §3.4 and in the file.

---

## 5. THE ENGINE AUTO-ROUTE: THE BRIEF'S SAFETY PREMISE WAS FALSE

The brief offered *"primary holds all channels post-migration; the A1 111-diff
must stay EMPTY"* as the argument that gating the auto-route was safe. I
re-derived it before building. **It is not true of this path.** Measured on the
owner's live `deliveries` ledger at `ac945a99`:

```
agent_id                              tool        channel    n    first        last
57b52025-…  (BehaviorBot, ronin)      auto-route  imessage  152   2026-07-27   2026-08-13
57b52025-…                            auto-route  email       7   2026-07-27   2026-07-28
57b52025-…                            engine-ack  imessage    3   2026-08-13   2026-08-13
kevin       (the primary)             auto-route  —           0
platform                              alert       imessage 1754   (the watchdog door, by design)
```

**Every engine-routed human delivery this box has ever made was sent by an agent
holding no channel grant, and the primary has made none.** BehaviorBot's stored
grants are `master:false, imessage:'none'`.

A1's snapshot read the TOOL door's rule (`isPrimaryAgent`) because that was the
only rule there was; **this path had no rule to snapshot**, so no derivation
could have preserved it — which is precisely why three phases handed it up. So
it is a REAL narrowing with a named victim, and it is recorded as one rather
than smuggled through as an empty diff. What it costs is bounded and visible:
the refusal is a ledger row, the reply is already persisted and broadcast to the
dashboard before any arm runs, and **one tick of the A3 panel's iMessage control
restores it** (driven as a test clause). The `image_create` door is empty-diff by
construction and the `queueAgentSay` door is too (`this.agentId` is
`getPrimaryAgentId()` for every session the platform opens).

**I did not touch BehaviorBot's grants.** Re-read at the end of the task, they
are exactly as A1 left them.

---

## 6. THE EXEMPLAR ACCEPTANCE — DRIVEN ON THE OWNER'S BOX

Both created through the **real panel door** (`POST /api/agents` with `grants`),
driven through the **real `executeTool`** against the live database, and torn
down through the **real deletion door** (`DELETE /api/agents/:id`).

### 6.1 Reader — Plaud + ONE mail account, no channels, no exec

Stored grants read back through `GET /agents/:id` (`effectiveGrants`):
categories = the floor three + Plaud + Gmail + Google Calendar + unified search;
`plaud:true`; `google {agent:'read', user:'none'}`; microsoft none; credentials
`[]`; every channel `none` under `master:false`; `techniques:[]`;
`exec_allow: []`.

```
advertised tools: 27
KEPT      gmail_inbox · email_search · calendar_agenda · file_read
STRIPPED  imessage_send · sms_send · voice_call · user_gmail_inbox
          · credential_get · web_search · exec

GRANTED SOURCES
  gmail_inbox               kind=applied                          ← its granted mailbox
  plaud: GRANT held=true    box connected=false
  plaud_recent_recordings   kind=failed  "Plaud is not connected. Ask the user to
                            connect Plaud from Settings → Integrations → Plaud."
                            ← A1's design: CONNECTIVITY wins, and the sentence
                              names the connection, never the grant

REFUSALS
  user_gmail_inbox   kind=refused  PERMISSION_DENIED
      "Permission denied: that Google account is not in this agent's grants."
  imessage_send      kind=refused  PERMISSION_DENIED   (row 7)
  exec               kind=refused  PERMISSION_DENIED
      "[BLOCKED] Permission denied: Command "uname" is not allowed…"

AUDIT (read back from audit_log)
  denied  tool_call  target=-           Google account not in this agent's grants
  denied  tool_call  target=imessage    imessage_send is restricted to the primary agent only
  denied  exec       target=uname -a    Command "uname" is not allowed…
```

The personal-mail refusal is the headline: **`gmail_inbox` works and
`user_gmail_inbox` is refused, on the same box, for the same agent** — the
work-vs-personal split the census said had nowhere to live.

### 6.2 Operator — exec + iMessage-me

```
advertised tools: 24
KEPT      exec · imessage_send · imessage_list_contacts · file_read
STRIPPED  sms_send · voice_call · gmail_inbox · plaud_list_recordings · credential_get

exec                     kind=applied    "a4-operator-live"
imessage_send → David    kind=failed     "iMessage bridge is currently disabled, so this
                                          message was NOT sent…"
                         ← PASSED EVERY PERMISSION DOOR; stopped by a channel-state fact
imessage_send → Devi     kind=refused    PERMISSION_DENIED
   "Permission denied: this agent may only iMessage David, and "Devi Okonkwo" is
    someone else. The message was NOT sent. Ask the primary agent to widen this
    agent's iMessage grant to "anyone approved" if this needs to happen."

AUDIT
  success  exec       target=echo a4-operator-live  a4-operator-live
  denied   tool_call  target=David                  bridge disabled
  denied   tool_call  target=Devi Okonkwo           channel tier is owner-only; recipient is not the owner
```

**This is the run that produced §3.4.** On the first drive both iMessage calls
returned the bridge sentence and the tier was unobservable; the ordering fix is
what makes the two lines above different, and the acceptance is what found it.

### 6.3 Teardown, and what the real door actually does

Both deleted through `DELETE /api/agents/:id`, `{"status":"terminated"}` for
each. **The platform's real deletion semantics is termination, not row removal**
(the archive sweep has a 7-day cutoff), so the two rows survive as `terminated`.
I used the door I was asked to use rather than reaching past it with a hand
`DELETE`. **The live agent count is now 113, of which these two are terminated**
— stated here because three reports have quoted "111" and the next reader should
not be surprised. Ids: `4e823e7f-7d70-418c-8be5-b48cba3f40a0` (Reader),
`6ff26c36-80e2-4a9f-acab-ae32e62aea67` (Operator).

---

## 7. THE TWO KIT REDS AT THE TIP ARE BOX STATE, AND THE CONTROL PROVES IT

At `68aaf10a` the roster was **8/8 exit 0** and `check-cache-prefix` passed with
no `--update` at the compared-region sha A2 and A3 shipped. At `753726db` two
checks are red. **The cause is the box's Plaud connection expiring during this
task** (`/api/plaud/status` went `connected:true` → `connected:false,
reauthRequired:true`), which strips the Plaud tool block from every agent's
index — `surface.ts` reads `isPlaudConnected() && mayUsePlaud(agentId)`.

The control is run **in the base tree alone — `ac945a99`, no A4 code at all** —
against two copies of the database, one taken before the expiry and one after:

```
BASE TREE, Plaud connected : kevin 36,741 bytes  sha 44034fae376f93d5   Plaud block PRESENT
BASE TREE, Plaud expired   : kevin 36,509 bytes  sha 293dffe37828ab35   Plaud block ABSENT
```

−232 bytes, same code, caused entirely by the box. And against either database
state, **kevin's prompt is byte-identical between `ac945a99` and this tree**
(§2). `check-assembled-context` fails for the same reason and by the same shape
(fixture 28,289 blessed → 27,083 live, Plaud block absent).

**NOT RE-BLESSED, deliberately.** Baking "Plaud disconnected" into either golden
would make the gate fail the moment the owner reconnects, which is the opposite
of what a golden is for. The blessed assembled-context value (28,289 = 28,680 −
391) is the correct A4 value for a box with Plaud connected. **Re-running the
roster after the owner reconnects Plaud is the action; no code change is owed.**

---

## 8. RED FIRST, RECORDED

Run in a worktree at `ac945a99`:

```
the-prompt-tells-the-truth.test.ts   11 failed |  6 passed   (applySoulCapabilityTruth
                                     is not a function; imessage_send still advertised
                                     to 110 agents; '## iMessage' still rendered)
the-technique-grant.test.ts          17 failed | 11 passed   (techniqueGrantFor is not a
                                     function; the index still lists every technique)
the-engine-route-asks.test.ts        did not collect — Cannot find module '../engine-route.js'
```

New: `the-prompt-tells-the-truth.test.ts` (**17**), `the-technique-grant.test.ts`
(**28**), `the-engine-route-asks.test.ts` (**25**).

Edited, and only where they PINNED the old mechanism; in each case the
requirement survives and is restated in the file:

- `channel-doors-tell-the-truth.test.ts` — its fixture drove a call with NO
  iMessage allowlist at all and still read the bridge sentence, which only
  worked because the bridge check was the handler's first statement. The
  requirement is unchanged (`sms_send` named first when SMS is live, dashboard
  as the fallback; HEAD's sentence byte for byte when nothing else is live);
  what changed is that the call must now be one the door would otherwise have
  PERFORMED, which is the honest precondition for *"the transport was the only
  thing stopping it"*.

**A gate caught my own test and it was right to.** `guard-corpus-census`
refused `the-engine-route-asks.test.ts` for hand-rolling a walk of
`agent/v2/steps` — *"a seventh hand-rolled copy of the engine walk is how the
corpus starts drifting again"*. It uses `engineFileContaining` now, which is
also the stronger clause: it follows the site instead of going quiet when
PHASE-6 moves it.

---

## 9. GATE-SIDE AND HOUSEKEEPING

- **The ratchet raises are their own commits** (`68aaf10a`, `753726db`), no
  product code. Fourteen pins raised with `--numstat` accounting and the comment
  share of each, and **three files admitted** at their current count rather than
  split — the visible decision the growth detector asks for: `shared/access.ts`
  (273, the pure model), `dashboard/lib/access-edits.ts` (272, the pure panel
  math), `agent/access/read.ts` (251, the one door every layer asks, whose memo
  cannot be split without duplicating a cache for one column).
- **`gates.ts` is STILL at its growth ceiling and A4 did not spend it.** 286
  against a 229 baseline (+25% = 286). W75's hand-up stands untouched: A4 needed
  no seventeenth ladder row, because the technique refusal is a HANDLER wall
  beside the state/squad rule it extends and the tier wall is a handler wall
  beside the four A1 wrote — which is where `handler-body-gates`' own census
  says such a decision belongs.
- **Report-tier reds are the same two A1, A2 and A3 recorded.** `capability-ledger`'s
  one missing capability (`job pm-agent:startPokeLoop#2`), and `deletion-ratio`
  refusing because the tree is dirty — the only untracked file is **W72's own
  census report**, which I did not commit (it is not mine). **No undeclared
  capability**: `GET /api/access/catalog` was added to the ledger by A3 and
  `engine-route.ts` exports functions, not a route or a job.
- The growth baseline still prints its staleness warning (recorded 2026-08-10).
  Pre-existing; re-recording widens the tolerance for 645 files at once and is
  an owner-visible decision, not a worker's.
- Kit instruments installed twice and **uninstalled and verified clean** both
  times (0 `[DEV-INSTRUMENTS]` markers). Worktree removed, every probe and drive
  script deleted from both trees, all temp directories removed, no background
  process left running. `git status` shows only W72's report. The owner's
  `tsx watch` dev server (pid 13224) was up before this task and is serving the
  branch.
- **The owner's live rows are untouched.** Re-read at the end: the seven live
  agents' grants are the A1 table exactly (`kevin master=1 imessage=all`,
  BehaviorBot `master=0`, the four other senseis `master=null`, every one
  `categories='*'`), and `techniques` is NULL on every row — the absent-key
  migration working.

---

## 10. NOT IN A4 — recorded, not done

1. **The refusal wording on ladder row 7 is still unchanged**, and this is the
   FOURTH time it is handed up. A1 deferred it to A3, A3 §7.7 deferred it to the
   owner because *"re-wording moves a string test files assert byte-for-byte,
   and the honest replacement depends on what the owner wants the sentence to
   say"*. A4 sharpens the case rather than improvising: the sentence
   *"only the primary agent can call imessage_send"* is now demonstrably false
   as a general statement — the Operator exemplar is a non-primary that CAN —
   though it remains true of every agent that actually reads it, and
   *"escalate to the primary agent"* is still correct guidance for them.
   Changing it would put a message delta into S1, which is the one section this
   phase's proof rests on. **The owner's wording, the owner's call.**
2. **`renderMessageSources` is still unconditional for every agent.** It names
   `sms_send` ("only for proactive sends"), `teams_send_message` ("only for
   starting new chats") and `voice_call_end` ("to hang up") in the cached prefix
   of agents holding none of those channels. It is one 40-line string whose
   bulk is inbound-tag DECODING rather than capability claims, so making it
   grants-conditional is a string surgery with real golden risk and modest
   payoff. The exact false clauses are named here so the next task does not have
   to re-find them. **Hand-up.**
3. **`renderGoogleAccess` / `renderMsAccess` still assert about OTHER agents**
   — *"Sub-agents have read-only access; you're the only agent with write."*
   Under grants the owner can give a sub-agent full write, and that sentence
   then reads false to the sub-agent itself. Making the clause primary-only is
   by-identity for kevin and cheap; it was left out because it is a claim about
   OTHERS rather than the agent's own ungranted ability, which is what scope
   item 1 names. **Hand-up, with the one-line fix identified.**
4. **Per-kind Workspace filtering at the SURFACE is still coarse** (A1 §6.6,
   A3 §7.6). The Reader exemplar reads *"You have read access to
   Gmail/Calendar/Drive/Docs/Sheets"* from `widestIntegrationLevel`, which
   collapses the two account kinds, while the DOOR is exact per kind — which is
   why `gmail_inbox` worked and `user_gmail_inbox` was refused for the same
   agent in §6.1. The prompt is coarser than the door in the safe direction.
5. **`tools.allow` still restricts rather than grants** (census C2/G2, carried
   unchanged from A1 §6.3 / A2 §6.5 / A3 §7.1).
6. **A non-primary sensei's MANIFEST is still not editable**, and
   **`update_agent` / `get_agent_profile` are still `PRIMARY_ONLY_TOOLS`** —
   A3 §7.4 and §7.5, unchanged.
7. **`voice-outbound.ts`'s `opening_message` and `CallSession`'s
   `'Hello there!'` opener are not gated by an agent grant**, and deliberately:
   the first was already authorized by the `voice_call` tool door and the second
   has no agent at all (it is the platform answering a call). The `null`-agent
   posture is written at the door.
8. **The two terminated exemplar rows.** §6.3. The deletion door terminates; I
   did not reach past it.

---

## 11. REPORT PATH

`.superpowers/sdd/UX-REPAIR/task-W76-report.md` (this file). Branch tip
`753726db`, four commits ahead of `ac945a99`, nothing pushed.
