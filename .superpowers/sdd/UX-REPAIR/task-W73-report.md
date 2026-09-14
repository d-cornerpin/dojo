# W73 — UX-ACCESS PHASE A1 (grants model · enforcement · migration)

Branch `ux-access-a1` from main `b382580`. Nothing pushed, no cut.

| commit | what |
|---|---|
| `a69d4a1d` | UX-ACCESS A1: one grants object per agent, enforced at every door |
| `52fb73e9` | gate-side: raise eleven ratchet pins (+133 lines, argued per file) |

---

## 1. VERDICTS

| gate | result |
|---|---|
| server unit suite | **378 files / 5407 tests green** (was 5404 at HEAD; +47 new, 24 edited) |
| `npm run typecheck` (shared + server) | **exit 0** |
| `npm run lint` | **0 errors**, 104 warnings = the pinned baseline exactly |
| `npm run build` (shared + server + dashboard) | **green** |
| `npm run gates:block` | **13/13 blocking gates green** |
| `npm run gates:report` | capability-ledger + deletion-ratio red — **both pre-existing**, re-verified at `b382580` (§7) |
| kit roster (`check-roster-conformance.mjs`) | **conformant** — 9 checkers, all named |
| kit prompt-gate roster | **8/8 exit 0 at `52fb73e9`**, record accepted by `check-prompt-gate-record.mjs` |

**Prompt-silent, and measured rather than claimed.** `check-cache-prefix` (prefix
byte-invariant across 9 turn-states), `check-prompt-inventory` (24 system + 12
message entries, exact roster and slot order), `check-assembled-context` and
`check-prefix-holds-still` are all green. No golden re-bless was needed or taken.
The capability diff below also compares each agent's full advertised tool-name
list, which is what the prompt's tool index renders from — it is empty for all
111. The cache tenet is honoured: no prefix byte moves.

---

## 2. WHAT LANDED

**ONE grants object per agent**, inside `agents.permissions` beside the manifest
it already carried. `packages/shared/src/access.ts` declares it:

- `tools` — `categories` (positive, by the 38 `TOOL_CATEGORIES` labels) + the
  migrated `allow`/`deny`
- `integrations` — `plaud`, `credentials` (`string[] | '*'`), and per provider a
  level for the `agent` and `user` account KINDS plus an optional per-ACCOUNT
  override map (the work-vs-personal split)
- `channels` — `master: boolean | null` (the über toggle), the five per-channel
  tiers beneath it, each `none | owner | all` (the me-vs-others tier)

**No schema migration, and that is the finding, not an omission.** The per-account
email/calendar grants fit the object: accounts are keyed by `kind` with ≤5 per
kind and a stable row id, so a junction table would have been a second authority
for a fact the one object already states. `grant_rule` is untouched — it keeps
being exactly what the census established it is (§1.4/C7): the derived cache of
the manifest's EFFECT kinds, whose only writer is its own reader. **Nothing new
for the release audit.** The data migration is code, not DDL (§4).

**Enforcement, per layer:**

| layer | site | before | after |
|---|---|---|---|
| model's tool list | `surface.ts` | `tools_policy` column; Plaud + credentials pushed unconditionally | `toolGrantsFor` reads the object; category / Plaud / credential grants filter |
| tool list, per account | `surface.ts` `isToolEnabledByService` ×2 | one level for both kinds | per-kind level from the grant |
| executor gate | `gates.ts` row 7 | `primary_only` | `channel:imessage` |
| executor gate | `gates.ts` **row 16, NEW** | nothing (`secrets` in `ungatedEffectKinds`) | `credential`, keyed on `args.service_name` |
| handler walls | `comms.ts` ×4 (sms, voice ×3) | `isPrimaryAgent` | `mayUseChannel(agentId, 'sms'\|'voice')` |
| handler walls | `provider/google.ts`, `provider/microsoft.ts` | `isPrimaryAgent` | `mayWriteWorkspace` / **new** `mayReadWorkspace` |
| executor fallback | `tools/index.ts:529` | `isPrimaryAgent` | `mayWriteWorkspace` |
| relay scope check | `a2a-transport.ts` `ownerChannelRelayRefusal` | `isPrimaryAgent` | `mayUseChannel` |
| access tier | `google/auth.ts:761`, `microsoft/auth.ts:616` | `_agentId` unused, role ladder | the agent's grant; connectivity still wins |
| write route | `routes/agents.ts` | — | grants carried forward so a permissions save cannot delete them |

**Every refusal message and audit-row detail is byte-identical to HEAD's.** The
walls kept their position and their words; only the predicate moved. A1 does not
re-word a refusal the owner cannot yet make false — that is A3's, once the panel
exists.

**The `isPrimaryAgent` hardcode is retired BEHIND the grants**: it survives only
inside `derive.ts`, where it is the migration reading HEAD's own rule. Post
-migration only the primary holds channel grants, so behaviour is unchanged.

**Owner ruling 1 in the model**: `channelTierOf()` is the only legal read and it
applies the master switch there, so "inert unless the master is on" is a property
of the reader. A sensei that is not the primary carries `master: null` — no such
toggle — and `null` is not "on".

**Owner ruling 3 — the boot rewriters retire. FIVE, not the four the census
named.** `pm-agent.ts`, `trainer-agent.ts`, `healer-agent.ts`,
`imaginer-agent.ts` and — found by driving the migration on the owner's own box
— **`vault/maintenance.ts` (the Dreamer's)**, which overwrote its grants 82
seconds after they landed and was the one row of 111 that did not survive a real
boot. Census C8 names only four writers; §7.3 lists the Dreamer among the five
machine-written policy rows. Held by a source census in
`the-doors-read-the-grants.test.ts` so a sixth cannot appear quietly.

*Why retiring them is safe*: the frozen deny list was never the wall. A sensei
other than the primary now carries no channel grant, so every tool on the
build-checked `SEND_TO_PEOPLE` surface is refused at the door — **including one
added after this boot**, which a frozen list of 155 names could never have
covered. The create/reactivate paths still write a policy (they mint a row rather
than revert a live one), held by a control clause.

---

## 3. MIGRATION-DIFF PROOF — **EMPTY, ALL 111 AGENTS**

Instrument: one probe script run in **both trees** against the same database,
asking each tree's OWN doors (the access module is imported optionally, so HEAD
answers with `isPrimaryAgent` and the branch answers with the grant). Per agent it
records the full advertised tool-name list, the executor deny set, 21 driven gate
verdicts, the five channel predicates, four relay verdicts, eleven Workspace
verdicts and a verdict per stored credential.

Database: a `.backup` of `~/.dojo/data/dojo.db` with `$.grants` stripped back out
(`json_remove`), reproducing the true pre-A1 state — 40 rows at `'{}'`, matching
census §7.2 exactly.

```
A(head@b382580) vs B(branch, lazy)           agents=111  EFFECTIVE-CAPABILITY DIFFS=0
A(head@b382580) vs C(branch, materialized)   agents=111  EFFECTIVE-CAPABILITY DIFFS=0
B(lazy) vs C(materialized)                   agents=111  EFFECTIVE-CAPABILITY DIFFS=0
✓ EMPTY DIFF across all 111 agents, in all three comparisons.
```

The only movement anywhere in the three snapshots is a gate's internal RULE
LABEL, enumerated rather than folded in:

```
GATE RULE-LABEL changes (verdicts identical):
  DENY:7:primary-only:imessage_list_contacts  =>  DENY:7:channel:imessage   x110
  DENY:7:primary-only:imessage_send           =>  DENY:7:channel:imessage   x110
```

Same row, same verdict, same message, same `errorCode`, same audit row.

**Three states, not two, on purpose.** Derivation is lazy — an agent with no
stored grants answers with its measured access at HEAD — so B proves the branch
is byte-equivalent *whether or not the migration ran*, and C proves writing the
value down changes nothing. Materialization is therefore provably a no-op and a
second pass writes zero rows.

**The 7 live agents are driven, on the owner's real box.** The dev server
(`tsx watch`, pid 13224, running since 30 Aug) hot-restarted on these edits and
ran the boot materializer against the live database for real:

```
111 agents, 111 with grants
57b52025 (BehaviorBot, ronin)  master=false  imessage=none  google read/read
dreamer  (sensei)             master=null   imessage=none  google read/read
healer   (sensei)             master=null   imessage=none  google read/read
imaginer (sensei)             master=null   imessage=none  google read/read
kelly    (sensei, PM)         master=null   imessage=none  google none/none
kevin    (sensei, PRIMARY)    master=true   imessage=all   google full/full
ticky    (sensei, Trainer)    master=null   imessage=none  google read/read
```

The Dreamer's row is how the fifth boot rewriter was found: at 110/111 it was the
one that kept losing its grants, 82 seconds after each boot wrote them.

---

## 4. THE NEGATIVE WALLS, DRIVEN

Through the real `executeTool`, on a copy of the owner's database, audit rows read
back afterwards. Each refusal carries its positive control.

| probe | agent | result |
|---|---|---|
| `imessage_send` | no channel grant | `kind=refused` · `PERMISSION_DENIED` · row-7 message byte-identical to HEAD |
| **`imessage_send`** | **granted `imessage:'owner'`, NOT the primary** | **passed the permission door, reached the bridge** — refused only by "iMessage bridge is currently disabled", a channel-state fact |
| `exec(["curl", …])` | `exec_allow: []` | `kind=refused` · `PERMISSION_DENIED` · the manifest half still bites |
| `credential_delete("stripe_live")` | granted `['plaud_token']` | `kind=refused` · `PERMISSION_DENIED` · **`stripe_live` row count before=1 after=1 (SURVIVED)** |
| `credential_get("plaud_token")` | same agent | `kind=applied` |
| `user_gmail_inbox` | `google.user='none'` | `kind=refused` · `PERMISSION_DENIED` · "that Google account is not in this agent's grants" |
| `gmail_inbox` | same agent | `kind=applied` — its OWN mailbox still works |

Audit rows written, all `result='denied'`:

```
a1-nogrant: tool_call target=imessage        :: imessage_send is restricted to the primary agent only
a1-nogrant: exec      target=curl https://…  :: Command "curl" is not allowed…
a1-reader:  tool_call target=stripe_live     :: credential "stripe_live" is not granted to this agent
a1-reader:  tool_call target=null            :: Google account not in this agent's grants
a1-operator:tool_call target=David           :: bridge disabled   ← the permission door PASSED
```

The second row of that table is the headline: census §9 case 2 records that the
only way to grant a non-primary agent iMessage was to make it
`config.primary_agent_id`, taking the channel away from the current primary. It is
a grant now.

**RED first, recorded**: `the-doors-read-the-grants.test.ts` was **12 failed / 5
passed** at `b382580` before any door was touched.

---

## 5. TESTS

New: `agent/access/__tests__/the-grants-are-the-authority.test.ts` (28) — the
model, the über toggle, the snapshot per agent class, materialization's empty
diff, the exemplar profiles, the channel-map census over `SEND_TO_PEOPLE`.
`agent/access/__tests__/the-doors-read-the-grants.test.ts` (19) — the doors, both
directions, plus the five-rewriter retirement census.

Edited, each because it PINNED the old mechanism; in every case the requirement
survives and only the predicate's name changed:

- `ladder-rows.test.ts` — row 7 is a `channel` gate; **row 16 added**, and the
  file's own promise ("a sixteenth requirement cannot be added without being
  covered") is what forced it there. Enumeration now `1..16`.
- `child-scope.test.ts` — `imessage_send` still withheld from a default
  sub-agent, by a declared gate.
- `channel-doors-tell-the-truth.test.ts` — row 7 re-keyed; its byte-for-byte
  message assertions untouched and still green.
- `relay-compose-agrees-with-wall.test.ts` — the one-predicate requirement holds;
  the predicate is `mayUseChannel`.
- `secret-at-rest.test.ts` — **clause 6 flipped, deliberately and visibly, which
  is exactly what it asked for.** It recorded the ungated credential store as an
  ALLOW and named the open question as the owner's; the owner answered it in the
  UX-ACCESS design. The scope is the GRANT, not "the agent that stored it".
- `mailbox-banner.test.ts` — test-harness mock gained `isPMAgent`.

---

## 6. NOT IN A1 — recorded, not done

1. **Owner ruling 2 (most-restrictive default for new agents).** Ships as
   `MOST_RESTRICTIVE_GRANTS` and is **not** any agent's default. Applying it in A1
   would narrow every sub-agent the platform spawns — a capability change, and the
   opposite of A1's bar — and A2 owns the `spawn_agent`/`update_agent` grant
   arguments that would let the primary grant access back. Without that door first,
   a restrictive default is a platform that cannot delegate.
2. **The engine auto-route paths** (`channel-push.ts:135,359`,
   `turn-closures.ts:381,443`) still cross no wall, exactly as at HEAD (census
   §2.4 items 2–3, C5). Gating them is a NARROWING — 1,873 iMessage deliveries on
   the dev box are engine-routed under the `platform` pseudo-agent id — so it is
   an owner decision, not a migration. **Hand-up.**
3. **`tools.allow` still restricts rather than grants** (census C2/G2). It moved
   into the object verbatim; changing its semantics would move kelly's, imaginer's
   and dreamer's surfaces. The positive primitive A1 delivers is the category /
   channel / integration / credential layer. A2/A3 own the tool-name half.
4. **The techniques section** is not in the object. A4 owns the wiring, and a
   declared field with no reader is the disease this repo is curing.
5. **Surface truth for channel tools.** Every agent is still ADVERTISED
   `imessage_send` and refused at the door, as at HEAD. Stripping it by grant
   would move ~110 agents' tool indexes — a prompt change A1 is committed to not
   making. A4 owns prompt/capability truth.
6. **Per-kind Workspace filtering at the SURFACE is coarse** (it withholds `none`,
   not `read` vs `full`); the DOOR is exact (`mayWriteWorkspace` reads the per-kind
   level). Post-migration both kinds are equal for every agent, so nothing differs
   today.
7. `getAgentPermissions` and `getAccessGrants` are two readers of one JSON column,
   reading disjoint keys. Deliberate and documented — one column, one place an
   owner's edit lands; a second table would have been a second truth.

---

## 7. GATE-SIDE AND HOUSEKEEPING

- The **ratchet raise is its own commit** (`52fb73e9`), no product code, +133
  lines itemised per file with the argument for each. New code lives in unpinned
  modules (50–198 lines each, all under the 240-line crossing rule); the growth
  detector is clean. `surface.ts` is +2 net because FU-4's tools-policy parser
  moved OUT (−27) to `agent/access/tools-policy.ts`, where A1 gave it a second
  caller, paying for most of the new filters.
- **Report-tier reds are pre-existing.** `capability-ledger`'s one missing
  capability (`job pm-agent:startPokeLoop#2`) reproduces identically at `b382580`
  — verified in a worktree. `deletion-ratio` refuses because the tree is dirty,
  and the only untracked file is **W72's own census report**, which I did not
  commit (it is not mine).
- The growth baseline prints a staleness warning (recorded 2026-08-10, 35 days).
  Pre-existing; re-recording is its own gate-side commit and not A1's.
- Worktree removed, probe scripts deleted, no background process left running.
  The owner's `tsx watch` dev server (pid 13224) was already up before this task
  and is now serving the branch — it is how the live migration was driven.

---

## 8. REPORT PATH

`.superpowers/sdd/UX-REPAIR/task-W73-report.md` (this file). Branch tip
`52fb73e9`, two commits ahead of `b382580`, nothing pushed.
