# W77 — UX-ACCESS PHASE A5 (the panel folds · credentials become one switch · every section reveals its children)

Branch `ux-access-a5` from `ux-access-a4` (`eff652d4`). Nothing pushed, no cut.

| commit | what |
|---|---|
| `48475aa6` | UX-ACCESS A5: the Access panel folds, credentials become one switch, every section reveals its children |
| `739338de` | gate-side: raise five ratchet pins for the UX-ACCESS A5 simplification |

---

## 1. VERDICTS

| gate | result |
|---|---|
| server unit suite | **386 files / 5608 tests green** (A4: 384 / 5552 — +2 files, +56 tests) |
| `npm run typecheck` (shared + server) | **exit 0** |
| `tsc -p packages/dashboard` | **exit 0** |
| `npm run lint` | **0 errors**, 104 warnings = the pinned baseline exactly |
| `npm run build` (shared + server + dashboard) | **green** |
| `npm run gates:block` | **13/13 blocking gates green** |
| `npm run gates:report` | capability-ledger + deletion-ratio red — **the same two A1–A4 recorded** (§9) |
| kit roster (`check-roster-conformance.mjs`) | **conformant** — 9 checkers, all named; 8 on the prompt-gate roster, 1 declared manual |
| kit prompt-gate roster | **8/8 exit 0** at `739338de`, record accepted by `check-prompt-gate-record.mjs` |
| **111-agent effective-capability diff** | **EMPTY** (§4) |

---

## 2. THE SCOPE AS IT ARRIVED — two orders, then two amendments mid-task

1. **The Access panel collapses, COLLAPSED by default**, matching the dashboard's
   existing collapse idiom.
2. **Credentials collapse to ONE toggle**, *"Access to stored credentials"* — and
   the MODEL simplifies with the UI: the grants field, A2's tool-door arg shape,
   the resolver, the executor wall, the capability line, and a migration that
   keeps the 111-agent diff empty.
3. *(amendment 1)* **Tools get a two-option selector** — "Full tool access" /
   "Individual tool access" — with the group checkboxes only under the second,
   and Full→Individual **pre-filling** rather than blanking.
4. *(amendment 2a)* **Techniques get a "Technique access" switch**, the list
   beneath it, all checked by default.
5. *(amendment 2b)* **Channels: the master reveals its children**, which default
   ON at the **"Only me"** tier; a customized child set survives an off→on flip
   inside one session.

All five landed. Everything below is measurement.

---

## 3. THE BRIEF'S PREMISE ON ORDER 1 WAS FALSE, AND THE CORRECTION IS IN THE CODE

Order 1 said *"other cards on the agent editor fold; reuse that pattern, don't
invent one."* Re-derived before building: **no card on the agent editor folds.**
`AgentConfigPanel.tsx` renders Name, Model, Classification, System Prompt, Memory
and Permissions as plain `.tile` cards with no collapse anywhere.

The idiom the order is pointing at is real, but it lives on **Settings →
Channels**: `CollapseToggle` + `usePanelCollapse`, used by
`GoogleWorkspaceSettings`, `MicrosoftWorkspaceSettings` and `TwilioSettings`,
persisted per-key to `localStorage`. **That is the one reused**, and no second
implementation was written.

One change was needed to reuse it honestly. `usePanelCollapse(key)` defaulted
every untouched key to EXPANDED, and all three existing callers were re-defaulting
at the call site with `collapsed[k] ?? true` — which is a latent bug, not a style
choice: `toggle` flips `!prev[k]`, so the first click on an untouched key that the
call site is *displaying* as collapsed sets it to `true` and nothing moves. The
default therefore moved INTO the hook (`usePanelCollapse(key, defaultCollapsed)`),
`toggle` flips away from it, and `isCollapsed(k)` is the only way to ask. The
three older callers now ask that way. **One reader, not four.**

The Access panel asks for `usePanelCollapse('agent.access.collapse', true)`. The
key is per-panel and not per-agent, because *"I keep this card shut"* is a fact
about the owner.

---

## 4. THE 111-AGENT DIFF — EMPTY, WITH THE FLAKE CONTROLLED FOR

Run in a worktree at `eff652d4` and in this tree, against the same database copy,
`HOME` redirected. **14 dimensions per agent over all 113 rows = 1,582 dimension
rows**: advertised surface · executor deny set · five channel predicates with
tier and me-vs-others · master presence · eight engine-route destinations · five
relay refusals · Plaud · the credential grant · a verdict per each of the 15
stored credentials · the technique grant · four Workspace levels · eight
Workspace read/write verdicts · **`accessLine`** · and **every declared gate's
verdict, row, kind, errorCode, resource, audit name, rule label and refusal
message across 17 calls**.

```
agents compared  : 113
dimension rows   : 1,582
DIFFS            : 2        — both in `gates`, both the same thing
agents differing : 4e823e7f… (A4 Reader)   6ff26c36… (A4 Operator)
```

**THE 111 LIVE AGENTS ARE UNTOUCHED — ZERO DIFFS.** The only two rows that move
are A4's two **terminated** exemplars, which are the only two rows on the box
holding `credentials: []`, and what moves is the refusal SENTENCE and nothing
else:

```
- Permission denied: the credential "plaud_token" is not in this agent's grants. …
+ Permission denied: this agent does not have access to stored credentials. …
verdict / row / kind / errorCode / resource / auditAs / rule : IDENTICAL for both agents
```

Proved separately and explicitly:

```
accessLine identical for every one of the 113 agents : true
advertised surface identical for every agent        : true
credential verdicts identical for every agent       : true
```

**A FLAKE WAS FOUND AND CONTROLLED FOR RATHER THAN EXPLAINED AWAY.** The first
comparison showed a third agent moving: `web_search` on `22079d33…` flipping
`ALLOW → DENY:network-unconfigured` at the net broker (ladder row 6). The control
is the base tree run **against itself**, same database copy, same commit:

```
BASE vs BASE, same commit, same DB : 1 agent differs
  - web_search|ALLOW:6:net:…:*:
  + web_search|DENY:6:net:…:network-unconfigured:
```

It is box state, not A5 — nothing in this change is within reach of the net
broker. The headline diff above is BASE-control vs A5.

---

## 5. CREDENTIALS: THE MODEL, THE MIGRATION, AND WHY THERE IS NO CONFLICT CASE

### 5.1 The measurement that decided the shape

Read on the owner's box at `eff652d4`, across all 113 stored rows:

```
integrations.credentials = "*"   × 111      every pre-A4 agent
integrations.credentials = []    ×   2      A4's two terminated exemplars
rows with no grants key at all   :   0
```

**No agent holds a partial set, and none can** — `derive.ts` answers `'*'` and
nothing else. So the fold `'*' → true` / `[] → false` is EXACT and the empty diff
is a property of the data, not a hope. **The conflict case the brief asked me to
stop and report does not exist on this box.**

`foldCredentialGrant` still has to answer a partial list, and it answers **UP**,
with the reason written beside it: a non-empty list already held the vault at the
surface strip (`holdsCredentialGrant`) and at the `credential_list` door. Anything
malformed denies — a broken field never widens.

### 5.2 What changed, end to end

| site | before | after |
|---|---|---|
| `shared/access.ts` | `credentials: string[] \| '*'` | `credentials: boolean` |
| | `mayTouchCredentialIn`, `holdsAnyCredentialGrant` | **both deleted**; `foldCredentialGrant` added |
| `access/read.ts` | `mayTouchCredential(id, service)` | **deleted**; `holdsCredentialGrant(id)` reads the field directly, exactly as `mayUsePlaud` does |
| `access/read.ts` `storedGrants` | — | **the fold, applied once, at the one read boundary** |
| `access/derive.ts` | `credentials: '*'` | `credentials: true` |
| `access/presets.ts` | `full_trust` names `'*'` | names `true`; the other three (incl. **Reader**) hold `false` |
| `authorize.ts` schema | `nameList.optional()` | `z.boolean().optional()` |
| `authorize.ts` `grantExcesses` | subset-of-names | Plaud's rule exactly: cannot grant what you do not hold |
| `authorize.ts` `mergeGrants` / `clampGrantsTo` | list arithmetic | one boolean |
| `gate-eval.ts` row 16 | **two** predicates (`service===null ? holds : mayTouch`) | **one** |
| `cat/agents.ts` `accessLine` | three-way ternary | two-way |
| `AccessPanel.tsx` | 1 "every" checkbox + N per-credential rows + a `listCredentials` fetch | **one toggle**, no fetch |
| `lib/access-edits.ts` | 4 functions | 2 |

**THE FOLD LIVES AT ONE BOUNDARY ON PURPOSE.** `storedGrants` is the only place a
stored document becomes an `AccessGrants`, so no door, route, panel or audit delta
ever sees A1's list shape — the boolean is not a type the tree merely claims.

### 5.3 The capability line does not move one byte

`credentials: all` / `credentials: none` are the exact words the `'*'` and `[]`
branches already produced, so the line is byte-identical for all 113 agents (§4).
The comma-list branch is gone with the shape that produced it. **`accessLine` is a
tool RESULT** (`spawn_agent`, `get_agent_profile`) — tail-side, never the cached
prefix. **Zero prompt bytes beyond what A4 registered; no golden moved.**

### 5.4 The refusal sentence, named as the brief asked

It changed shape, deliberately, and it is the only message that did:

```
before  Permission denied: the credential "stripe_live" is not in this agent's grants. …
        Permission denied: the credential store is not in this agent's grants. …
after   Permission denied: this agent does not have access to stored credentials.
        The request was not performed. Ask the primary agent to grant it if this needs to happen.
```

One sentence for all five tools, named or bare. It described a per-credential rule
that no longer exists. `gate.service` survives as the audit **resource**: the
message lost detail on purpose, the ledger row did not.

---

## 6. DRIVEN — THE REFUSAL, THROUGH THE REAL DOORS

Real panel door (`POST`/`PUT /api/agents`), real `executeTool`, real `audit_log`,
on a **copy** of the owner's database with `HOME` redirected. **No row was written
on the owner's live box.**

```
1 · CREATED credentials OFF through the panel door
    stored integrations.credentials = false     holdsCredentialGrant = false
    credential tools ADVERTISED: (none — the surface strip)

2 · THE EXECUTOR WALL — all five tools
    credential_list    kind=refused blocked=true code=PERMISSION_DENIED
    credential_get     kind=refused blocked=true code=PERMISSION_DENIED
    credential_add     kind=refused blocked=true code=PERMISSION_DENIED
    credential_update  kind=refused blocked=true code=PERMISSION_DENIED
    credential_delete  kind=refused blocked=true code=PERMISSION_DENIED
    "Permission denied: this agent does not have access to stored credentials.
     The request was not performed. Ask the primary agent to grant it if this needs to happen."

    AUDIT (read back from audit_log)
      denied  tool_call  target=stripe_live  this agent has no access to stored credentials
      denied  tool_call  target=plaud_token  this agent has no access to stored credentials
      denied  tool_call  target=x            this agent has no access to stored credentials
      denied  tool_call  target=plaud_token  this agent has no access to stored credentials
      denied  tool_call  target=-            this agent has no access to stored credentials
                                             ↑ credential_list, which names none

3 · THE OWNER TICKS THE ONE TOGGLE
    PUT {grants:{integrations:{credentials:true}}}  ok=true   stored = true
    audit: "grants set by owner (dashboard): integrations.credentials: false → true"
    credential tools ADVERTISED now: credential_list, credential_get, credential_add,
                                     credential_update, credential_delete
    credential_list  kind=applied  "15 credential(s) stored: …"

4 · THE OLD SHAPE IS REFUSED, WITH THE FIELD NAMED
    "*"              400  invalid grants — integrations.credentials: Expected boolean, received string
    []               400  invalid grants — integrations.credentials: Expected boolean, received array
    ["plaud_token"]  400  invalid grants — integrations.credentials: Expected boolean, received array
    unchanged after all three: true          ← a refused body writes nothing

5 · A LEGACY STORED ROW FOLDS, NO REWRITE
    stored "*"                → effective true   holds=true
    stored []                 → effective false  holds=false
    stored ["plaud_token"]    → effective true   holds=true

6 · TEARDOWN through the real deletion door → {"status":"terminated"}
```

---

## 7. DRIVEN — THE PANEL, IN A REAL BROWSER (Playwright)

Real routers + the real built dashboard + a copy of the owner's database, `HOME`
redirected. Deliberately **not** a second platform boot: no poller, no Healer, no
bridge — a second process holding the owner's rows must not be able to reach a
person. Agent: **BehaviorBot** (a ronin, so it has a master switch; `master:false`,
`categories:'*'`, `credentials:'*'`, no `techniques` key).

```
1 · THE CARD OPENS COLLAPSED
COLLAPSED   sections=0  checkboxes=0  presets=0
COLLAPSED   chevron aria-expanded=false  label="Expand Access"
COLLAPSED   summary: "all tools · reaches no one · credentials on"
COLLAPSED   stored credentials="*"  categories="*"  master=false

2 · EXPAND / COLLAPSE / EXPAND
EXPANDED      sections=4  presets=4  aria-expanded=true
RE-COLLAPSED  sections=0
RE-EXPANDED   sections=4

3 · TOOLS — the selector and the PRE-FILL
TOOLS              Full selected=true  Individual selected=false
TOOLS              group checkboxes while Full: 0
TOOLS  Individual  group checkboxes=38  CHECKED=38   ← pre-filled, not blanked
TOOLS              stored row UNCHANGED by the flip: "*"
TOOLS  back to Full  group checkboxes=0  Full selected=true

4 · CREDENTIALS — one toggle
CREDENTIALS   credentials stored on this box: 15
CREDENTIALS   controls matching a credential: 1   checked=true
CREDENTIALS   "Every stored credential" control present: 0
CREDENTIALS   integrations-section checkboxes total: 6   (Plaud + accounts + the one toggle)

5 · CHANNELS — the master reveals, and defaults to "Only me"
CHANNELS off  per-channel controls rendered: 0
CHANNELS on   iMessage=true/Only me  SMS=true/Only me  Phone calls=true/Only me
              Email=true/Only me  Microsoft Teams=true/Only me
CHANNELS on   rows=5   "Anyone approved" selected anywhere: 0   ← never defaulted
-- the owner unticks two, flips the master off, flips it back --
CHANNELS edited    iMessage=true  SMS=true  Phone calls=false  Email=true  Teams=false
CHANNELS off       rows rendered: 0
                   help="This agent cannot reach a person on any channel. Turn the switch on to choose which."
CHANNELS on again  iMessage=true  SMS=true  Phone calls=false  Email=true  Teams=false
                   ← the customized set was RESTORED, not re-defaulted

6 · TECHNIQUES — a switch over the list
TECHNIQUES  switch aria-checked=true   stored=(absent — reads as "*")
TECHNIQUES  on   4 boxes, 4 checked
TECHNIQUES  off  0 boxes, 0 checked
TECHNIQUES  on   4 boxes, 4 checked    ← all checked by default

7 · SAVE, AND THE ROUND TRIP
SAVE     credentials=false  categories="*"
SAVE     channels={"master":true,"imessage":"owner","sms":"owner","voice":"none",
                   "email":"owner","teams":"none"}
SAVE     audit: "grants set by owner (dashboard): integrations.credentials: true → false;
                 channels.master: false → true; channels.imessage: "none" → "owner";
                 channels.sms: "none" → "owner"; channels.email: "none" → "owner""
RE-OPEN  credentials toggle checked=false   master aria-checked=true
RE-OPEN  iMessage=true/Only me  SMS=true/Only me  Phone calls=false  Email=true/Only me  Teams=false
RE-OPEN  Save disabled (nothing dirty)=true

8 · A SENSEI STILL GETS NO MASTER SWITCH
SENSEI   master switches=0   per-channel controls=0
SENSEI   credentials toggle present=1   tool mode=Full
```

Two things worth naming in that trace:

- **`integrations.credentials: true → false` in the audit is the migration
  working in public.** The stored row said `'*'`; the panel read `true`, wrote
  `false`, and the delta names the boolean.
- **The box had no PUBLISHED techniques** (4 drafts, 0 published), so the
  Techniques section correctly rendered A4's empty state. The four drafts were
  published **in the database copy** to exercise the switch. Nothing was published
  on the owner's live box.

Screenshots: `/tmp/w77-1-collapsed.png` · `w77-2-expanded` · `w77-3-tools-individual`
· `w77-4-master-on` · `w77-5-saved` · `w77-6-reopened`.

---

## 8. RED FIRST, AND THE TEST ESTATE

Run in this tree at `eff652d4` before a line of implementation:

```
the-credential-grant-is-one-switch.test.ts  +  the-panel-reveals-its-children.test.ts
                                     50 failed | 7 passed  (57)
  foldCredentialGrant is not exported · MOST_RESTRICTIVE holds [] ·
  mayTouchCredentialIn alive · grantsPatchSchema accepts '*' ·
  no toolMode / techniqueAccessOn / credentialsGranted ·
  setMaster touches no channel · usePanelCollapse takes one argument ·
  AccessPanel.tsx contains no collapse at all
```

New: `the-credential-grant-is-one-switch.test.ts` (**28**),
`the-panel-reveals-its-children.test.ts` (**29**).

**THE PANEL'S PURE MATH IS NOW IMPORTED, NOT ONLY CENSUSED.** A3 and A4 asserted
about `access-edits.ts` as TEXT. The new file imports it and drives it: the mode
flip and its pre-fill, the technique switch's all-checked default, the master's
default-and-restore rule, and the patch shape are functions under test. The React
shape stays a source census, and the Playwright run above is what exercises it for
real.

**Four existing files were edited, and only where they PINNED the old mechanism.**
In each the requirement survives and is restated in the file:

- `the-grants-are-the-authority.test.ts` — `describe('credentials are scoped to
  the grant')` becomes `describe('the credential vault is reachable only by
  grant')`. The per-name fixtures are gone with the mechanism; census C3's hole
  (*any agent reads, updates or DELETES any credential*) is the same hole and is
  still asserted shut, with the positive control beside it.
- `the-doors-read-the-grants.test.ts` — the ungranted-SERVICE fixture becomes an
  ungranted-AGENT fixture. The audit still names the credential reached for.
- `the-tool-door-grants.test.ts` — the no-escalation clause becomes Plaud's clause
  exactly, and still pins that an agent cannot mint a child that reaches a vault
  it cannot reach itself.
- `the-access-panel.test.ts` — A3's *"the per-channel rows are DISABLED beneath
  the master"* becomes *"they do not exist beneath it"*, which is strictly
  stronger (there is no control to reach at all). The requirement it carried —
  owner ruling 1's "inert unless the master is on" — is unchanged and still lives
  in `channelTierOf`.

### The kit prompt-gate roster

Instruments installed for the run and **uninstalled and verified clean**
afterwards (§9). **The owner reconnected Plaud during this task**
(`/api/plaud/status` → `connected:true, reauthRequired:false`), which is the state
A4 §7 said the two reds it recorded were waiting for.

```
check-cache-prefix       exit 0   prefix byte-invariant across 9 turn-states, kevin (system 35,776 chars)
check-prompt-inventory   exit 0   24 system + 12 message entries, exact roster + slot order pinned
check-steer-delivery     exit 0   the engine steer reached the model
check-message-prefix     exit 0   judged, driven by the check
check-prefix-holds-still exit 0   TAIL HELD — divergence only at REGISTERED deliberate blocks
check-assembled-context  exit 0   9 turn-states, two assembles each and identical
check-reanswer-ghost     exit 0   LAW HOLDS — 54 in, 54 out
check-roster-conformance exit 0   9 checkers, all named

✓ prompt-gate record accepted — 8 blocking gate(s) green, 0 acknowledged red(s), at 739338de
```

**8/8, AND NO GOLDEN WAS RE-BLESSED.** `check-cache-prefix` passed **with no
`--update`** — the cache tenet holding: A5 moves no prompt byte, and the one text
it does change (`accessLine`'s credential clause) is a tool result on the tail
side and is byte-identical for every agent on this box anyway.
**`check-assembled-context` is GREEN at A4's blessed value with the Plaud block
back**, which closes A4 §7 exactly as A4 predicted it would: no code change was
owed, only the reconnection.

---

## 9. GATE-SIDE AND HOUSEKEEPING

- **The ratchet raise is its own commit** (`739338de`), no product code. Five
  pins, each with `--numstat` accounting and its comment share, because **four of
  the five are files whose executable code SHRANK while their account of the rule
  grew**:

  ```
  access-edits.ts   +42 net   executable net  -8   (47 comment added, 4 deleted)
  shared/access.ts  +28 net   executable net  -2   (two readers deleted, one added)
  access/read.ts    +13 net   13 of 20 added lines comment
  cat/agents.ts      +1 net    2 of 3 added lines comment
  AccessPanel.tsx   +41 net   15 of it code — the smallest net of the five orders
                              it carries, after deleting the per-credential list,
                              the two "every …" checkboxes, the disabled channel
                              rows and two hand-rolled radiogroups
  ```

- **Report-tier reds are the same two A1–A4 recorded.** `capability-ledger`'s one
  missing capability (`job pm-agent:startPokeLoop#2`), and `deletion-ratio`
  refusing because the tree is dirty — the only untracked file is **W72's own
  census report**, which I did not commit (it is not mine).
- **CSS:** `.acx-children.is-off` deleted with the dimming it existed for;
  `.acx-head` added for the card's header row, arranged the way the three channel
  panels arrange theirs.
- Kit instruments installed once and **uninstalled, verified clean** (0
  `[DEV-INSTRUMENTS]` markers in `packages/` and `watchdog/`). The base worktree
  was removed, the temporary harness directory deleted, the Playwright harness
  stopped, and every probe and drive script lives in the session scratchpad and
  not in the repo. No background process left running.
- **The owner's live rows were not touched by this task.** The capability probe,
  the refusal drive and the Playwright run all ran against `.backup` copies with
  `HOME` redirected. The owner's `tsx watch` dev server (pid 13224) was up before
  this task and is serving the branch.

---

## 10. NOT IN A5 — recorded, not done

1. **A mode flip is not remembered across a second flip.** Full → Individual →
   Full → Individual re-expands to today's whole list rather than restoring the
   set the owner ticked in between. That is the owner's own model mapping ("Full"
   IS `'*'`, and under `'*'` the effective set is every group), and nothing saves
   until Save, so the cost is bounded to one un-saved editing session. Restoring
   it would need panel-local memory of a set the model does not carry. **Named
   rather than smuggled.**
2. **The technique switch does not restore a custom set the way the master does.**
   Off → On writes `'*'` (all checked), which is exactly what amendment 2a asks
   for. The channels case is different because A3 deliberately made per-channel
   values survive a `false` master; `techniques` has no such inert half.
3. **The refusal wording on ladder row 7 is still unchanged** — the FIFTH time
   this is handed up (A1 → A3 → A4 → here). A4 §10.1 sharpened the case and left
   it with the owner; A5 did not touch it, because changing it would put a message
   delta into the capability diff this phase's proof rests on.
4. **`renderMessageSources` is still unconditional for every agent** (A4 §10.2),
   and **`renderGoogleAccess` / `renderMsAccess` still assert about OTHER agents**
   (A4 §10.3). Untouched, unchanged.
5. **Per-kind Workspace filtering at the SURFACE is still coarse** (A1 §6.6, A3
   §7.6, A4 §10.4).
6. **`tools.allow` still restricts rather than grants** (census C2/G2, carried
   from A1 §6.3 through A4 §10.5).
7. **A non-primary sensei's MANIFEST is still not editable**, and `update_agent` /
   `get_agent_profile` are still `PRIMARY_ONLY_TOOLS` (A3 §7.4–7.5, A4 §10.6).
8. **A4's two terminated exemplar rows are still on the box** (A4 §6.3). They are
   the only two rows whose refusal SENTENCE moves in §4, and they are terminated.

---

## 11. REPORT PATH

`.superpowers/sdd/UX-REPAIR/task-W77-report.md` (this file). Branch tip
`739338de`, two commits ahead of `eff652d4`, nothing pushed.
