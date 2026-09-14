# W75 — UX-ACCESS PHASE A3 (the Access panel · presets · toggle cleanup · the category-gate rider)

Branch `ux-access-a3` from `ux-access-a2` (`191bc84c`). Nothing pushed, no cut.

| commit | what |
|---|---|
| `5af855fe` | UX-ACCESS A3: the Access panel, its presets, and the category grant reaches the executor |
| `1a40078a` | gate-side: eight ratchet pins and one capability row |

---

## 1. VERDICTS

| gate | result |
|---|---|
| server unit suite | **381 files / 5482 tests green** (A2: 379 / 5440 — +2 files, +42 tests) |
| `npm run typecheck` (shared + server) | **exit 0** |
| `npm run lint` | **0 errors**, 104 warnings = the pinned baseline exactly |
| `npm run build` (shared + server + dashboard) | **green** |
| `npm run gates:block` | **13/13 blocking gates green** |
| `npm run gates:report` | capability-ledger + deletion-ratio red — **both the same two A1 and A2 recorded** (§8) |
| kit roster (`check-roster-conformance.mjs`) | **conformant** — 9 checkers, all named |
| kit prompt-gate roster | **8/8 exit 0 at `1a40078a`**, record accepted by `check-prompt-gate-record.mjs` |

**PROMPT BYTES: ZERO, AND IT WAS MEASURED.** `check-cache-prefix` is green with
no `--update`: prefix byte-invariant across 9 turn-states, **compared-region
sha256 `98864a0aa32bcf6b…` — the same value A2 shipped** — 14 rendered slots all
declared, the whole tools JSON byte-identical to the golden, and its three
self-test arms BIT on planted breaks. `check-prompt-inventory` confirms the
24 + 12 slot roster and order unchanged. A3 adds no tool, no tool-schema field
and no prompt slot: the panel is dashboard code, the catalog is an owner-side
route, and row 17 changes a REFUSAL, not a surface. **No golden re-bless was
needed or taken. The cache tenet holds.**

---

## 2. WHAT LANDED

### 2.1 The Access panel (scope item 1)

`packages/dashboard/src/components/AccessPanel.tsx` (356) +
`packages/dashboard/src/lib/access-edits.ts` (234). The split is the same seam
the server uses between `authorize.ts` and `gate-eval.ts`: what a change MEANS is
a pure function of two objects, and the component only renders and asks.

| section | what the owner sees | what it writes |
|---|---|---|
| **Tools** | 38 group checkboxes + an "Every tool group — including groups added by future updates" switch | `tools.categories` |
| **Integrations** | Plaud · one row per CONNECTED Google/Microsoft account, with its email and a Read / Read & write tier · a checkbox per stored credential + an "every credential" switch | `integrations.*` |
| **Channels** | the über toggle, with the five per-channel grants and the me/others tiers BENEATH it | `channels.*` |
| **Techniques** | the equipped-techniques control, moved in from its own card | `equipped_techniques` (unchanged path) |

Four rules are in the pure module rather than at six call sites, each because
getting it wrong would be silent:

- **`'*'` is a promise about the FUTURE, not a full list.** Unticking one group
  under `'*'` expands to every group that exists TODAY minus that one, so the
  owner never accidentally keeps a grant for a category invented next month.
- **A save carries only what moved.** A2's PUT merges over the current object, so
  sending the whole thing would make every save a change in the audit log.
- **An agent whose master is `null` has no channel section, on the WIRE.** The
  patch omits `channels` entirely for it — stronger than disabling a control,
  and it is owner ruling 1 held by construction.
- **The KIND level follows the ACCOUNTS.** The advertised surface reads the
  per-kind level (A1 §6.6) while the door reads the per-account override, so
  unticking every account of a kind narrows the kind too. Otherwise `gmail_*`
  stays on the model's tool list for an agent that is refused at the door —
  exactly the advertised-vs-permitted drift this phase exists to end.

It binds to `effectiveGrants` from A2's GET (declared on `AgentDetail` this
phase) and saves through A2's PUT — same resolver, same validation, same audit
row. **The panel owns no authority of its own.**

### 2.2 The presets (scope item 2)

`agent/access/presets.ts`, served with the group list at **`GET /api/access/catalog`**
(`gateway/routes/access.ts`, the one new route). Server-side because a preset
names TOOL GROUPS and the group list is a server module — a copy in the dashboard
would drift the first time a tool is re-filed.

| preset | grants |
|---|---|
| **Most restrictive** | `MOST_RESTRICTIVE_GRANTS` byte for byte (ruling 2's default) |
| **Reader** | Plaud + Gmail/Outlook/both calendars/unified search + recall + vault, `read` on both providers and both kinds, **no channel** |
| **Operator** | the floor three + `Communication`, `master:true`, `imessage:'owner'`, nothing else |
| **Full trust (primary-like)** | `'*'` categories, `'*'` credentials, Plaud, `full` everywhere, every channel at `all` |

A preset **fills the boxes and saves nothing** — the owner adjusts and presses
Save. Two properties are tests, not intentions: every category a preset names
exists in `TOOL_CATEGORIES`, and **no preset grants a channel without the tool
group that channel's send tool lives in** (A2 §6.2's hand-up). `channelToolGroups`
answers that second one by DERIVING from `SEND_TO_PEOPLE` + `channelOfSendTool`,
so re-filing `imessage_send` moves the answer with it.

### 2.3 The toggle cleanup (scope item 3) — three things stopped lying

1. **"Send iMessages" is DELETED.** Census §9.1 G1: it wrote
   `tools_policy.deny += imessage_send` when off and removed it when on, but
   turning it ON granted nothing, because the channel door refused every
   non-primary agent regardless. Shown on every agent's editor, a no-op on all of
   them. The Channels section is the control that can actually grant it. Its
   deny in `DEFAULT_SUBAGENT_TOOLS_POLICY` went with it — a deny that duplicates
   a wall is a second authority for one fact.
2. **The `toolsPolicy` FOLD — a lie A1 left behind.** A1 moved the authority for
   the per-agent tool allow/deny out of the `tools_policy` COLUMN into the grants
   object (`surface.ts` reads `toolGrantsFor`, the FU-4 executor re-check asks the
   same reader) and taught `spawn_agent` to carry its `tools` argument across
   (A2 §5). **`PUT /agents/:id` was never taught**, so the dashboard's Web Search
   and Web Browsing toggles have been writing to a field no door reads. Same
   fold, verbatim; the column keeps its value because it is still the legacy
   record other readers display.
3. **The sensei notes.** `isPrimary` in the agent editor was the CLASSIFICATION
   under a name that claimed otherwise, and two cards keyed claims about "the
   primary agent" off it. **Measured on the owner's box:** of the five senseis
   that are NOT the primary, three (Kelly/PM, Imaginer, Dreamer) carry
   `exec_allow: []` — so *"This Sensei agent has full access to all files,
   commands, tools, and system controls"* was false for most of the agents it was
   shown to, and the System Prompt card told all six that their edits rewrite
   SOUL.md, which is the primary's file. The real primary now comes from
   `useActiveAgent().primaryId`, the source the agent card already uses.

### 2.4 The rider: row 17, the category grant at the executor (scope item 4)

A2 §6.1's finding, closed. `toolCategoryGranted` had exactly ONE caller — the
surface strip — and per Architecture Rule 1 the strip is ADVICE.

| layer | before | after |
|---|---|---|
| declaration | `gatesForCall` minted 16 row kinds | + `{kind:'category', row:'17'}`, **last**, and only for tools the index names |
| evaluation | `gate-eval` had no category arm | `toolCategoryGranted` — the SAME predicate the strip asks |
| refusal | — | plain message naming the group, `PERMISSION_DENIED`, audit row with the group as the resource |

Row 17 is **last** so no existing refusal changes its message (order is
observable and scenarios assert on it), and a tool the index does not name mints
no gate at all — the grant is a positive layer over the 38 declared groups, not
an allow-list of every name the platform can mint.

### 2.5 And an ordering defect, found and fixed

A2's grant write ran BEFORE the `UPDATE agents SET …` batch at the foot of the
PUT handler, and that batch re-writes `permissions` from a value read *before*
the grant resolution — so a body carrying both `permissions` and `grants`
silently reverted the grant half. The old permissions editor sends `permissions`
+ `toolsPolicy` in one body and the panel sends `grants`: the shape is live, not
contrived. Validation and its 400 stay where they were (a bad body still writes
nothing); only the WRITE moved past the batch.

---

## 3. THE PANEL, DRIVEN (Playwright, a real browser)

Against the REAL routers and the REAL built dashboard, on a `.backup` of the
owner's database with `HOME` redirected. Deliberately **not** a second full
platform boot: a second process holding the owner's rows must not be able to
reach a person, so the harness mounts the routers and serves `dist` and boots no
poller, no Healer, no bridge.

```
LOGIN            ok
LOAD             checkboxes=65  masterSwitch=1  presets=4
LOAD             stored row: {"master":false,"imessage":"none",…}   master aria-checked=false
PRESET Operator  Communication=true  iMessage=true  master=true
PRESET Operator  stored UNCHANGED by the click: true        ← a preset saves nothing
SAVE             categories=["Meta","File & System","Managing Other Agents","Communication","Web"]
SAVE             channels={"master":true,"imessage":"owner","sms":"none",…}
SAVE             audit=[{"result":"success","detail":"grants set by owner (dashboard):
                   tools.categories: "*" → [...]; integrations.plaud: true → false;
                   integrations.credentials: "*" → []; channels.master: false → true;
                   channels.imessage: "none" → "owner"}]
RE-OPEN          Communication=true  Web=true  iMessage=true
RE-OPEN          master=true  tier="Only me"   save button disabled (nothing dirty) = true
```

The owner clicked *Operator*, ticked *Web*, chose *Only me*, saved, and the
re-opened panel shows exactly that. One PUT per save (counted at the network
layer), one audit row.

**The über-toggle gates its children, visually and in the object:**

```
GATING   master off -> children disabled: [true,true,true,true,true]   (all five channels)
GATING   children dimmed in the DOM: true                              (.acx-children.is-off)
GATING   saved object: master=false imessage="owner"
GATING   audit: "grants set by owner (dashboard): channels.master: true → false"
         channelTierOf(saved, 'imessage') = none   |   mayReachChannel = false
```

The per-channel value survives under a `false` master and is INERT — owner ruling
1 as a property of the reader (`channelTierOf`), which is why turning the master
back on restores the tiers the owner chose instead of silently erasing them.

**A sensei card shows no master toggle:**

```
SENSEI   stored master=null
SENSEI   master switches on the card = 0        per-channel checkboxes = 0
SENSEI   note: "This agent has no “allowed to talk to humans” switch. It communicates
          through the main agent, which is how the dojo's sensei agents have always worked."
SENSEI   its OTHER access is editable: tool groups on the card = 38    ← ruling 3's spirit
```

**A2 §6.2's hand-up, answered on screen** (untick `Communication` with iMessage
granted):

```
INERT WARNING   "iMessage is granted, but the “Communication” tool group is not — the agent
                 would be refused when it tried. Tick that group above."
```

It SAYS so rather than refusing the edit, because refusing would mean the panel
silently ticking a tool group the owner did not choose. Since the rider the
sentence is literally true: the call is refused, not merely inert.

Screenshots: `/tmp/a3-1-loaded.png` · `a3-2-preset` · `a3-3-saved` ·
`a3-4-master-off` · `a3-5-sensei` · `a3-6-inert`.

---

## 4. THE RIDER, DRIVEN (the real `executeTool`)

A2's own measured shape as the fingerprint: an `operator` agent holding
`master:true` + `imessage:'owner'` and NOT holding `Communication`.

```
OPERATOR   imessage_send advertised on the surface: false      ← the strip already hid it
FREE-TEXT  kind=refused  blocked=true  errorCode=PERMISSION_DENIED
FREE-TEXT  "Permission denied: imessage_send is in the "Communication" tool group, which is
            not in this agent's grants. The request was not performed. Ask the primary agent
            to grant that group if this needs to happen."
FREE-TEXT  audit: tool_call | target=Communication | denied
            "imessage_send is in the "Communication" tool group, which is not in this agent's grants"

CONTROL    group granted -> kind=failed
            "iMessage bridge is currently disabled, so this message was NOT sent…"
```

The control is the same sentence A1 §4 and A2 §4.5 ended on: with the group
granted the call passes **every permission door** and is stopped only by a
channel-state fact. Nothing reached a person.

`blocked=true` matters: `classifyToolResult` reads the error code, so a settled
"no" is not handed back to the loop as something worth retrying — the same lesson
A2 §4.3 paid for.

---

## 5. THE CONTROLS — A1's 111-AGENT DIFF PROBE, RE-RUN EMPTY

The same instrument A1 §3 and A2 §5 used, run in a worktree at `191bc84c` and in
this tree, against the SAME database copy. Per agent it records the stored grants
text, the full advertised tool-name list, the executor deny set, five channel
predicates and tiers, both providers × both kinds plus four read and four write
Workspace verdicts, Plaud, the credential-grant verdict and a verdict per stored
credential (15 of them), and **every declared gate's row, kind, verdict, rule,
refusal message, errorCode, resource and audit name across 24 calls**.

```
agents A2/A3: 111 111
row-17 gate lines in A3: 2553      row-17 lines that are NOT ALLOW: []
row-17 lines in A2: 0
stripped md5 A2: 26de64055252ec190a276b59041f8be3
stripped md5 A3: 26de64055252ec190a276b59041f8be3
EFFECTIVE-CAPABILITY DIFFS (row 17 excluded): 0
```

Two facts, stated separately on purpose. **Every pre-existing verdict, rule
label, message and error code is byte-identical** — not one moved, unlike A1
which had two rule labels to enumerate. And the **2,553 new row-17 evaluations
are ALL ALLOW**: the rider refuses nobody who is alive today, because A1's
snapshot gives every existing agent `categories: '*'` — 111 of 111, re-measured
on the live database this task.

**The owner's live rows are untouched.** Re-read at the end of the task: 111
agents, 111 with grants, `kevin master=1 imessage=all`, BehaviorBot `master=0`,
the four other senseis `master=null`, every one `categories='*'` — the A1 table
unchanged. Every probe ran against a `.backup`.

---

## 6. RED FIRST, RECORDED

```
the-category-gate.test.ts   at 191bc84c:  10 failed | 3 passed   (no row 17, no category arm)
the-access-panel.test.ts    at 191bc84c:  did not collect — Cannot find module '../presets.js'
                             (and: GET /api/access/catalog 404s; a PUT {toolsPolicy}
                              leaves grants.tools.deny exactly as it was)
```

New: `agent/access/__tests__/the-category-gate.test.ts` (**13**) — the
declaration, the refusal on A2's measured shape with its positive control, the
two-groups case, ruling 2's default at the executor, and the migration-safety
walk over every tool in the index. `agent/access/__tests__/the-access-panel.test.ts`
(**28**) — the four presets and their honesty rules, the catalog route, the
`toolsPolicy` fold with its audit row and its no-op control, the ordering fix,
and the panel/editor source census the Playwright run then drives.

Edited, and only where they PINNED the old mechanism; in each case the
requirement survives and is restated:

- `ladder-rows.test.ts` — the enumeration is `1..17` and the file's own promise
  ("a new requirement cannot be added without being covered") is what forced row
  17 to land there. Five clauses that COUNT a tool's gates now use `effectRows()`
  (row 17 filtered) because they are each asking about that tool's EFFECT doors —
  "exec and shell are disjoint", "web_browse holds two", "applescript_run is one
  class" — and row 17 is the same gate on every indexed tool.
- `handler-body-gates.test.ts` — its "NEITHER IS A DUPLICATE" clause said in
  writing that if a later task declared a row for these tools, *"whoever wrote it
  must decide deliberately which mechanism owns the refusal — never both, never
  neither"*. The decision is in the file: **row 17 asks about the GROUP, the
  handler-body `checkPermission` asks about the PATH**. The file-write refusal
  still has exactly one owner, and the clause now asserts its own requirement
  with the category row filtered out rather than weakened.

---

## 7. NOT IN A3 — recorded, not done

1. **`tools.allow` still restricts rather than grants** (census C2/G2, A1 §6.3,
   A2 §6.5). A3 surfaces the categories, the integrations, the credentials and
   the channels; the raw allow/deny stay in the permissions editor's Advanced
   disclosure, where they now reach the grants object again (§2.3). Changing what
   `allow` MEANS would move kelly's, imaginer's and dreamer's surfaces — an owner
   decision, still open.
2. **The engine auto-route paths** (`channel-push.ts:135,359`,
   `turn-closures.ts:381,443`) still cross no wall, exactly as at A1, A2 and HEAD.
   Unchanged hand-up.
3. **The techniques section is the existing control, not a grant.** The plan's
   A4 owns wiring techniques INTO the object; A3 moved the existing
   `equipped_techniques` control into the panel's fourth section verbatim (same
   selector, same route, same save-on-change) rather than inventing a field A4
   owns. On a box with no published techniques the section renders one honest
   line and no control, which is what the old card did silently.
4. **A non-primary sensei's MANIFEST is still not editable** (files, commands,
   system control). A3 only stopped the card claiming otherwise. Making it
   editable means deciding what the boot reconcilers may overwrite — ruling 3
   settled that question for GRANTS, not for the manifest. **Hand-up.**
5. **`update_agent` / `get_agent_profile` are still `PRIMARY_ONLY_TOOLS`** (A2
   §6.3), so a non-primary still cannot re-grant an agent it created. A3 did not
   surface that question because the panel is the OWNER's door; it stands as A2
   left it.
6. **Per-kind Workspace filtering at the SURFACE is still coarse** (A1 §6.6). The
   panel narrows the kind alongside the account (§2.1) so the two agree for
   anything the owner sets; an agent whose per-account overrides were written by
   a MODEL through `update_agent` could still be advertised more than it holds.
7. **The refusal wording on row 7 is unchanged.** A1 deferred it to A3 "once the
   owner has a panel that can make the sentence false". The panel now exists —
   but re-wording *"only the primary agent can call imessage_send"* moves a
   string four test files assert byte-for-byte, and the honest replacement
   depends on what the owner wants the sentence to say. **Hand-up, deliberately
   not improvised.**

---

## 8. GATE-SIDE AND HOUSEKEEPING

- **The ratchet raise is its own commit** (`1a40078a`), no product code: seven
  pins raised and one new file admitted, each with its accounting in the commit
  message and its argument at the entry in `ratchets.json`.
- **`gates.ts` is AT its growth ceiling and that shaped the code.** It stood at
  280 against a baseline of 229 recorded 2026-08-10, and the growth detector
  refuses above +25% — 286 lines. Row 17's declaration is therefore **six lines**
  (3 code, 3 comment) with its argument living where it can be checked: the test
  file and the `case 'category'` arm. **HAND-UP:** the next task that adds a row
  must shrink that file or re-record the baseline, and re-recording widens the
  tolerance for all 644 files at once — an owner-visible decision, not a worker's.
  The baseline is 35 days past its 30-day shelf life and says so on every run.
- **`AccessPanel.tsx` is admitted at 356 lines** rather than split further. The
  growth detector asks for exactly this when an unlisted file crosses 240 of the
  400-line cap, and pinning it is the visible decision it wants. It is already
  split on the real seam — the grant MATH is `lib/access-edits.ts` (234 lines,
  pure, no React); splitting again would divide four sections of one form across
  files that only ever change together.
- **Capability ledger: one row added by hand** (`route,GET /api/access/catalog`).
  The checker's own `--write` refreshes the WHOLE file and would have carried 142
  lines of pre-existing line-number drift into an A3 commit. Its one remaining
  finding — `job pm-agent:startPokeLoop#2`, recorded `built`, not in the tree — is
  the same one A1 and A2 recorded and is not A3's.
- **`deletion-ratio` refuses because the tree is dirty**, and the only
  uncommitted file is **W72's own census report**, which I did not commit (it is
  not mine). Same as A1 and A2.
- **The wiring walk caught a real hole and it was a true one**: it could not
  resolve `./routes/access.js` or `../components/AccessPanel` while those files
  were untracked. Staged, re-run, green — 641 production files, 0 unexplained.
- Kit instruments installed for the prompt-gate roster and **uninstalled and
  verified clean** afterwards (0 `[DEV-INSTRUMENTS]` markers). Worktree removed,
  harness and probe scripts deleted from the tree (`git status` shows only W72's
  report), no background process left running, port 3987 free. The owner's
  `tsx watch` dev server (pid 13224) was up before this task and is serving the
  branch.

---

## 9. REPORT PATH

`.superpowers/sdd/UX-REPAIR/task-W75-report.md` (this file). Branch tip
`1a40078a`, two commits ahead of `191bc84c`, nothing pushed.
