# W74 — UX-ACCESS PHASE A2 (the tool door · ruling 2 · no escalation · capability truth)

Branch `ux-access-a2` from `ux-access-a1` (`53955b0b`). Nothing pushed, no cut.

| commit | what |
|---|---|
| `6ec6ba38` | UX-ACCESS A2: the tool door — grants ride spawn_agent/update_agent, most-restrictive default, no escalation |
| `01be7573` | gate-side: raise four ratchet pins and admit one new file (no product code) |

---

## 1. VERDICTS

| gate | result |
|---|---|
| server unit suite | **379 files / 5440 tests green** (A1: 378 / 5407 — +1 file, +33 tests) |
| `npm run typecheck` (shared + server) | **exit 0** |
| `npm run lint` | **0 errors**, 104 warnings = the pinned baseline exactly |
| `npm run build` (shared + server + dashboard) | **green** |
| `npm run gates:block` | **13/13 blocking gates green** |
| `npm run gates:report` | capability-ledger + deletion-ratio red — **both pre-existing**, the same two A1 recorded (§7) |
| kit roster (`check-roster-conformance.mjs`) | **conformant** — 9 checkers, all named |
| kit prompt-gate roster | **8/8 exit 0 at `01be7573`**, record accepted by `check-prompt-gate-record.mjs` |

**PREFIX COST: ZERO, AND IT WAS MEASURED RATHER THAN HOPED FOR.** The task asked
me to note any tools-array prefix cost and batch the re-bless. There is none to
batch. `check-cache-prefix` byte-compares the tools JSON in full and is green
with no `--update`, because the cached prefix carries only the agent's
ALWAYS-LOADED schemas — 29 of them for Kevin — and `spawn_agent` / `update_agent`
are not among them. They are two-phase-loaded through `load_tool_docs`, so the
two new `grants` schemas ride the un-cached tail, on demand, on the turns that
ask for them. The tool INDEX lists names only and did not move.
`check-prompt-inventory` confirms the 24 + 12 slot roster and order are
unchanged. **No golden re-bless was needed or taken. The cache tenet holds; no
prefix byte moves.**

---

## 2. WHAT LANDED

**`agent/access/authorize.ts` is `agent/scope.ts` for grants**, and the shape is
copied on purpose rather than re-invented, because `scope.ts` already answers the
same three questions for the permission MANIFEST:

| | manifest (`scope.ts`, PHASE-5 T5) | grants (`authorize.ts`, A2) |
|---|---|---|
| VALIDATED | `manifestSchema`, malformed → refuse | `grantsPatchSchema`, malformed → refuse |
| SUBSET | `scopeExcesses`, child ⊆ parent | `grantExcesses`, grantee ⊆ granter's **effective** grants |
| REFUSE | every excess named | every excess named |
| entry | `resolveChildScope` | `resolveSpawnGrants` / `resolveUpdateGrants` |

The subset check reads the granter's **effective** grants, which is where the
master switch does real work for free: `channelTierOf` already applies it, so an
agent whose master is off holds `'none'` on every channel and can therefore grant
no channel — without that rule being written down a second time.

**The one rule that is not a subset rule** is the human-channel master. Ruling 4:
*"the human-channel master on a spawned agent may be set by the primary … but
never by a non-primary."* That is an identity rule, not a holdings rule — an
`operator` agent that legitimately holds `master:true` and `imessage:'all'` still
may not mint a second agent that talks to humans. Taken **literally**: a
non-primary naming `channels.master` at all is refused, in either direction,
because "never set it" is the least ambiguous reading and it is the safe one. A
non-primary that wants to withhold a channel withholds the CHANNEL, which it may.

**The excess check reads the PATCH, not the merged result.** `update_agent`
merges over the target's current object; a target already carrying
`credentials:'*'` from the A1 migration is not something the caller granted, and
refusing an unrelated edit over it would make the door unusable on exactly the
agents the owner most wants to narrow.

**Ruling 2 is wired in `spawnAgent`, not at the tool** — the same structural
reason the spawn gate lives there (PHASE-5 T5's note): that function writes the
row and has callers that never enter the executor. A default that is not on every
path is not a default. **Prospective, never retrospective**, exactly as
`defaultChildScope` is: no agent alive today is re-scoped, and A1's materializer
still answers for every row that predates this.

**Sites:**

| layer | site | before | after |
|---|---|---|---|
| schema | `definitions.ts` ×2 | no access argument existed | `grants` on `spawn_agent` + `update_agent`, three nested sections |
| spawn | `spawner.ts` | `permissions` + `tools_policy` only | `grants` param → `resolveSpawnGrants` → written into the `permissions` document |
| tool | `cat/agents.ts` `spawn_agent` | — | forwards `grants` raw; `GrantRefusedError` → plain message + `PERMISSION_DENIED` + audit; success → audit with the delta; result carries an `Access:` line |
| tool | `cat/agents.ts` `update_agent` | `permissions` / `tools` only | `grants` → `resolveUpdateGrants` → `writeGrants` + audit, both directions |
| truth | `cat/agents.ts` `capabilityClause` | advertised surface only | + the CHANNEL grant for `messaging people` |
| truth | `cat/agents.ts` `get_agent_profile` | raw `permissions` blob | + an `── Access ──` section: the capability clause and the access line |
| route | `routes/agents.ts` `GET /:id` | `effectiveScope` | + `effectiveGrants` |
| route | `routes/agents.ts` `POST /` | manifest only | + `grants`, same resolver, same default |
| route | `routes/agents.ts` `PUT /:id` | A1's carry-forward | + a validated `grants` door, same merge, same audit row |
| model | `shared/access.ts` | `MOST_RESTRICTIVE_GRANTS` unused | corrected (below) and now THE default |
| write | `access/materialize.ts` | `writeGrantsIfAbsent` | `writeGrants` promoted out of it; one writer for the column |
| read | `access/read.ts` | `getAccessGrants` | + `readStoredGrants` (declared-or-null, beside the derivation it must not be confused with) |

---

## 3. THE CORRECTION TO `MOST_RESTRICTIVE_GRANTS` — MEASURED, NOT CHOSEN

A1 shipped the constant as `tools.categories: ['Meta', 'File & System']` and
never consumed it. Wiring it verbatim would have shipped a broken spawn, and the
measurement is what says so — run against the real category index at `53955b0b`,
over the platform's own `SUB_AGENT_ALWAYS_LOADED` list:

```
KEPT     load_tool_docs    <- Meta
KEPT     file_read / file_write / exec / get_current_time / convert_time  <- File & System
STRIPPED complete_task     <- Managing Other Agents
STRIPPED send_to_agent     <- Managing Other Agents
```

`complete_task` and `send_to_agent` are the sub-agent's own lifecycle, not a
reach outside the dojo: `tools/tool-docs.ts` puts `complete_task` on EVERY
agent's always-loaded list with the reason *"complete_task is how sub-agents
signal they are done"*, and the spawn contract's initial message instructs the
new agent to call it. A default that strips both hands the agent an always-loaded
list of tools it does not hold and leaves it unable to report or to end.

So `'Managing Other Agents'` joins the list, with the argument at the
declaration. **Granting it reopens nothing**, because every dangerous member is
walled independently and those walls are unchanged: `spawn_agent` / `kill_agent`
/ `spawn_timeout_decision` by the manifest's `can_spawn_agents` (surface strip +
ladder row 4), `update_agent` / `get_agent_profile` / the four group verbs by
`PRIMARY_ONLY_TOOLS` (surface strip + row 9), `reset_session` by row 10, and
`complete_task` itself by FN-8's `agentCanSelfComplete`. What a default-spawned
agent actually gains is `list_agents`, `list_models`, `send_to_agent`,
`broadcast_to_group` and `complete_task` — intra-dojo coordination and its own
lifecycle. Driven, the resulting surface is **22 tools** (§4).

---

## 4. THE DRIVING PROOFS

Through the real `executeTool` and the real Hono router, on a `.backup` of the
owner's live database (`HOME` redirected, so the running dev server's rows are
untouched). The owner's `tsx watch` dev server (pid 13224, up since 30 Aug) is
also serving this branch: healthy, 111 agents, 111 with grants, and the seven
live agents' grants byte-unchanged from A1's table.

### 4.1 Ruling 2 — a spawn that names no grants

```
spawn kind=applied
Access: tools: 3 categories (Meta, File & System, Managing Other Agents)
      | humans: none | integrations: none | credentials: none
stored grants === MOST_RESTRICTIVE : true
advertised tools: 22
  KEPT      file_read · file_write · scratchpad_set · complete_task · send_to_agent
  STRIPPED  web_search · gmail_inbox · credential_get · credential_list
            · imessage_send · vault_search · plaud_list_recordings
mayUseChannel(imessage) = false
```

The `Access:` line is appended to the tool result on purpose: ruling 2's
narrowing is only humane if it is visible at the moment it happens.

### 4.2 A granted spawn, and its walls

```
Access: tools: 4 categories (…, Web) | humans: imessage:owner
      | integrations: none | credentials: plaud_token

AUDIT  kevin -> 879aa35a  result=success
  grants: tools.categories: ["Meta","File & System","Managing Other Agents"]
        → ["Meta","File & System","Managing Other Agents","Web"];
          integrations.credentials: [] → ["plaud_token"];
          channels.master: false → true; channels.imessage: "none" → "owner"

credential_get("plaud_token")  -> kind=applied
credential_get("stripe_live")  -> kind=refused  PERMISSION_DENIED
  "the credential "stripe_live" is not in this agent's grants…"
  AUDIT  879aa35a -> stripe_live  result=denied
```

### 4.3 NO ESCALATION, from a non-primary that genuinely holds something

```
(a) grant a credential it does not hold          -> kind=refused
    An agent can only grant access it holds itself — integrations.credentials:
    cannot grant "stripe_live" — it is not in your credential grant.
(b) a NON-PRIMARY sets the human-channel master  -> kind=refused
    … — channels.master: only the primary agent may set another agent's
    "allowed to talk to humans" switch.
(c) grant a channel TIER above its own           -> kind=refused
    … — channels.imessage: cannot grant "all" — you hold "owner" on that channel.
(d) POSITIVE CONTROL: passing on what it DOES hold -> kind=applied
    Access: tools: 4 categories (…, Web) | humans: none | credentials: plaud_token
```

All three refusals wrote an audit row (actor, target, delta/reason).

**`kind=refused` is a fix this run produced.** The first driven attempt came back
`kind=failed`: `classifyToolResult` reads the ERROR CODE and never the prose, and
an access refusal carrying none classifies as *the tool crashed* — so
`toolWasBlocked` is false and the loop is told a settled "no" is worth retrying.
Both grant refusals now carry `PERMISSION_DENIED`, held by clause 4b of
`the-tool-door-grants.test.ts`.

### 4.4 `update_agent`, both directions

```
widen  -> Updated Dana: access grants: tools.categories: […] → […,"Web"];
          channels.master: false → true; channels.imessage: "none" → "owner"
          mayUseChannel(imessage) now = true
narrow -> Updated Dana: access grants: channels.master: true → false
          mayUseChannel(imessage) now = false
re-applying the same value -> "No changes: Dana already matches the requested values."
```

Both lands audited on the actor with the target and the delta; the no-op writes
nothing, which is what makes "a grant change wrote a row" a fact rather than a
habit.

### 4.5 Capability lines vs the walls — four differently-granted agents

| agent | grants | `list_agents` clause | driven `imessage_send` |
|---|---|---|---|
| Kevin (primary) | everything | `can: … messaging people` | passed the door, stopped by *"iMessage bridge is currently disabled"* |
| Rosa | Communication + `imessage:'owner'` | `can: messaging people` | passed the door, same bridge stop |
| Rosa, after `master:false` | Communication, no channel | `no: … messaging people` | `refused` · `PERMISSION_DENIED` |
| Dana (default) | most restrictive | `no: … messaging people` | `refused` · `PERMISSION_DENIED` |

`get_agent_profile`'s new section, driven:

```
── Access ──
Capability: can: web research; no: email, calendar, files, messaging people
Access: tools: 4 categories (Meta, File & System, Managing Other Agents, Web)
      | humans: imessage:owner | integrations: none | credentials: plaud_token
```

### 4.6 Owner-side API parity (scope item 5), driven through the router

```
GET  /:id   ok=true  effectiveScope=true  effectiveGrants=true
POST /      no grants named  -> stored === MOST_RESTRICTIVE : true
POST /      grants named     -> mayUseChannel(imessage)=true, categories as asked
PUT  /:id   ok=true  plaud=true email=owner mayUseChannel(email)=true
  AUDIT  result=success  "grants set by owner (dashboard): integrations.plaud:
         false → true; channels.master: false → true; channels.email: "none" → "owner""
PUT  /:id   {channels:{imessage:"sometimes"}}  -> 400
  "invalid grants — channels.imessage: Invalid enum value…"   (imessage still: none)
PUT  /:id   {nonsense:true}                    -> 400
  "invalid grants — (root): Unrecognized key(s) in object: 'nonsense'"
A1 CONTROL: PUT {permissions:{…}} (the old editor) -> grants survive untouched
```

---

## 5. THE CONTROLS

**A1's capability diff probe, re-run: EMPTY over all 111 agents.** Same script,
same database, run in a worktree at `53955b0b` and in this tree. Per agent it
records the full advertised tool-name list, the executor deny set, the five
channel predicates and tiers, four relay verdicts, Plaud / credential-grant /
per-credential verdicts, the Workspace tiers and eight read/write tool verdicts,
and every declared gate's verdict + row + errorCode + refusal message across
fourteen calls.

```
A(A1 @53955b0b) vs B(A2 @01be7573)   agents=111   EFFECTIVE-CAPABILITY DIFFS = 0
cmp: BYTE-IDENTICAL      md5 both sides: b9064aaa71a503d7067d0075ce32b8bf
```

Not one gate rule-label moved this time either — unlike A1, which had two to
enumerate. Existing agents are untouched in every respect the probe can see.

**Back-compat: a PRE-A2 shaped `spawn_agent` call still works**, driven:

```
spawn_agent({tools:{deny:['web_fetch']}, permissions:{file_read:'*', exec_allow:['ls']}})
  -> kind=applied
  tools.deny carried into the grants: ["web_fetch"]
  web_fetch advertised: false      (the deny still bites)
  exec advertised: true            (the manifest argument still lands)
  manifest half survives beside the grants: exec_allow=["ls"] file_read="*"
```

That fold is not cosmetic. A1 made the grants object the authority for what the
`tools_policy` column used to say, so a spawn that now STORES grants must carry
`args.tools` into them or the argument silently stops working. It is folded
verbatim and deliberately **not** subject to the no-escalation rule — judging it
would invent a refusal for a call that works today.

---

## 6. NOT IN A2 — recorded, not done

1. **The category grant is SURFACE-ONLY; there is no executor gate for it.**
   `toolCategoryGranted` has exactly one caller (`surface.ts:634`), and per
   Architecture Rule 1 the surface strip is advice. So an agent granted a CHANNEL
   but not the tool's CATEGORY passes the permission door if the model emits the
   call from free text, while its capability line says it cannot. Measured: the
   `operator` agent (`imessage:'owner'`, no `Communication`) reads `no: messaging
   people` and reached the bridge when driven. Adding a row-17 category gate is a
   NARROWING — RULING P5-R5 makes that the owner's call, not a worker's — and it
   is the same class as A1 §6.3's `tools.allow`. **Hand-up.** The clause stays
   surface-plus-channel on purpose: it answers *"can I delegate this?"*, and an
   agent that cannot see the tool cannot be relied on to use it.
2. **A channel granted without its tool category is inert**, for the same reason.
   The `Access:` line states both halves so the fact is visible, but A3's panel
   should refuse to let the owner set one without the other, or say so on screen.
   **Hand-up to A3.**
3. **`update_agent` and `get_agent_profile` are `PRIMARY_ONLY_TOOLS` (row 9).**
   So the only path a NON-primary has to the grant door is `spawn_agent` — which
   is why the driven escalation proofs above go through spawn, and why the
   no-escalation rule on the update path can today only ever bind the primary.
   The rule is the same function on both paths; whether a non-primary should be
   able to re-grant an agent it created is an owner question A3 will surface.
4. **The engine auto-route paths** (`channel-push.ts:135,359`,
   `turn-closures.ts:381,443`) still cross no wall, exactly as at A1 and at HEAD.
   Unchanged hand-up (A1 §6.2).
5. **`tools.allow` still restricts rather than grants** (census C2/G2). A2 added
   a no-escalation clause for it — a caller whose own surface is curated cannot
   mint a child with no curation — but did not change what it MEANS. A3 owns that.
6. **The techniques section** is still not in the object. A4 owns the wiring.
7. **Surface truth for channel tools** is unchanged: every agent is still
   advertised `imessage_send`. A4 owns prompt/capability truth; A2 changed only
   the tool-RESULT lines, which is why the prefix did not move.
8. **The non-primary master rule is taken literally** — a non-primary may not
   name `channels.master` even to set it `false`. That is the safe reading of
   "never set it"; if the owner wants a non-primary to be able to MUTE a child it
   spawned, that is a one-line change in `grantExcesses` and it is his call.

---

## 7. GATE-SIDE AND HOUSEKEEPING

- The **ratchet raise is its own commit** (`01be7573`), no product code, four
  pins raised and one new file admitted, each with its argument and its
  line-by-line accounting in the commit message. `authorize.ts` is 423 lines,
  above the 400 new-file cap, so it is admitted by hand where it can be argued
  with; the alternative was splitting the zod schema away from the rule that
  reads it. `readStoredGrants` and `writeGrants` were deliberately NOT put in it
  — they live beside the derivation they must not be confused with (`read.ts`)
  and beside the migration that already merged grants into the `permissions`
  DOCUMENT (`materialize.ts`), so that column keeps one reader and one writer.
  The growth detector is clean.
- **`effects-conformance`'s clause-9 walk found a real defect and I fixed it
  rather than ruled around it.** The first `grants` schema was a flat
  `type:'object'` whose description advertised `integrations` and `channels` as
  fields the schema did not declare. Declaring them nested is the honest fix; the
  gate is what caught it.
- **Report-tier reds are the same two A1 recorded.** `capability-ledger`'s one
  missing capability (`job pm-agent:startPokeLoop#2`) and `deletion-ratio`
  refusing because the tree is dirty — the only untracked file is **W72's own
  census report**, which I did not commit (it is not mine).
- The growth baseline still prints its staleness warning (recorded 2026-08-10).
  Pre-existing; re-recording is its own gate-side commit and not A2's.
- Kit instruments installed for the prompt-gate roster and **uninstalled and
  verified clean** afterwards (0 markers left). Worktree removed, probe scripts
  and the database copy deleted, no background process left running. The owner's
  dev server (pid 13224) was up before this task and is serving the branch.

---

## 8. TESTS

New: `agent/access/__tests__/the-tool-door-grants.test.ts` (**30**) — the
declared argument, ruling 2's default and its lifecycle clause, the eight
no-escalation rules with their positive controls, malformed-refuses, the two
resolvers, the classification-and-audit census, the delta, and the write door.
**RED at `53955b0b`: module not found (`../authorize.js` did not exist).**

Edited, and only because it PINNED the old mechanism:
`agent/tools/cat/__tests__/the-delegation-door-states-capability.test.ts`
(14 → **17**). T43a's requirement — capability truth at the delegation door —
survives intact; what changed is that the fixture must now state the CHANNEL
grant as well as the tool, because the wall does. Section 2b is new and holds
A2's half: an advertised `imessage_send` with no channel grant reads as cannot,
the grant flips it back, and the control proves the grant alone is not enough.

---

## 9. REPORT PATH

`.superpowers/sdd/UX-REPAIR/task-W74-report.md` (this file). Branch tip
`01be7573`, two commits ahead of `53955b0b`, nothing pushed.
