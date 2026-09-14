# W78 — UX-ACCESS PHASE A6 (one Access panel · five plain questions · the permissions card folds in)

Branch `ux-access-a6` from `ux-access-a5` (`9184d6cf`). Nothing pushed, no cut.

| commit | what |
|---|---|
| `9621c082` | UX-ACCESS A6: one Access panel, five plain questions, and the permissions card folds in |
| `548e5f8f` | UX-ACCESS A6 rider: the reach summary reads the value, not the switch |
| `8be2b03c` | gate-side: pin the four new UX-ACCESS A6 files at their measured size |

---

## 1. VERDICTS

| gate | result |
|---|---|
| server unit suite | **387 files / 5647 tests green**, exit 0 (A5: 386 / 5608 — +1 file, +39 tests) |
| `npm run typecheck` (shared + server) | **exit 0** |
| `tsc -p packages/dashboard` | **exit 0** |
| `npm run lint` | **0 errors**, 104 warnings = the pinned baseline exactly |
| `npm run build` (shared + server + dashboard) | **exit 0** |
| `npm run gates:block` | **13/13 blocking gates green** |
| `npm run gates:report` | capability-ledger + deletion-ratio red — **the same two A1–A5 recorded** (§8) |
| kit roster (`check-roster-conformance.mjs`) | **conformant** — 9 checkers, 8 on the prompt-gate roster, 1 declared manual |
| kit prompt-gate roster | **8/8 exit 0** at `548e5f8f`, record accepted by `check-prompt-gate-record.mjs` |
| **prompt bytes** | **ZERO** — `check-cache-prefix` green with NO `--update` (§6) |
| **111-agent effective-capability diff** | **EMPTY — 0 diffs over 7,345 dimension rows** (§3) |

---

## 2. WHAT LANDED

### 2.1 The card: one line, then five questions

The panel opens **collapsed**, and its header carries a one-line plain-English
digest derived from the stored object on every render — there is no summary field
anywhere, because a stored summary is a second copy of a fact.

```
Full tools · talks to you only · 3 connections
3 tool groups · talks to no one · 2 connections
Full tools · talks to you and approved contacts · 6 connections · runs programs
```

Inside are **five folded rows**, each a question, each carrying its own state on
its shut header, each through the dashboard's one collapse idiom
(`usePanelCollapse` + `CollapseChevron`, one key per row, all defaulting shut).

| row | what it holds |
|---|---|
| **What it can do** | A5's Full / Individual tool selector and the 38 groups |
| **What it can reach** | Plaud · the connected Google/Microsoft accounts by name · *Search the web* · *Open web pages* · *Run programs on this Mac* · *Use stored keys & logins* |
| **Who it can talk to** | A5's channels under the one switch that governs them |
| **What it knows** | *Knows who you are* · the technique grant and the pre-load list |
| **What it may manage** | your files · this Mac · other agents · an Advanced disclosure |

`runsPrograms` is the one clause of the digest that is not a grant — it is the
manifest's `exec_allow`, passed in rather than read, and it earns its place by
being the most consequential thing an agent can hold. It is appended only when
true, so the common line matches the owner's example exactly.

### 2.2 The layout and the tint

One `<Item>` is one line of question, one line of help and its control on the
right, at one height, whatever the control is (`min-height: 46px`); anything a
control reveals is indented under the same left rule the panel already used.
Every switch, checkbox, radio group and row header is drawn **at rest**, not on
hover — the owner's standing note — and the row header is a real `<button>` with
`aria-expanded`, so it is keyboard- and screen-reader-reachable.

`is-risk` is **one class, set from one prop**, and it is worn by exactly five
things: *Run programs on this Mac*, *Use stored keys & logins*, *Delete files*,
*Automate Mac apps*, *Set what other agents may do*.

### 2.3 Language

Measured on the **rendered** card, not promised in a comment (§5, §7):

```
"sensei" on the rendered card:     false
"ronin" on the rendered card:      false
"apprentice" on the rendered card: false
"a2a" on the rendered card:        false
"über" on the rendered card:       false
```

An agent with no switch of its own is now described by what that means:

> *"This is a helper agent that talks through your main agent, so it has no
> switch of its own. Everything else here is still yours to set."*

The presets are re-described in the owner's own register, and one of the four
sentences **was false**: *"Operator — Runs commands on this Mac and can iMessage
you"*. A preset is a GRANTS object and cannot grant `exec_allow`, which lives in
the permission manifest, so the first half was never true of the profile the
button applies. The grants did not move; the sentence did.

```
Most restrictive  Its own files and nothing else. No people, no accounts, no keys. Every new agent starts here.
Reader            Looks at things, touches nothing, stays quiet — your recordings, mail and calendar, read only.
Operator          Can text you on iMessage — you and nobody else on the contact list.
Full trust        Everything your main agent holds: every tool, every account, your keys, every channel, everyone.
```

---

## 3. THE 111-AGENT DIFF — EMPTY, WITH THE FLAKE CONTROLLED FOR

Run in a worktree at `9184d6cf` and in this tree, against the **same copy** of
the owner's database, `HOME` redirected. **65 dimensions per agent over all 113
rows = 7,345 dimension rows**: the stored grants text · `accessLine` · the whole
advertised tool-name list · the executor deny set · the master · five channels
with tier and me-vs-others · Plaud · the credential grant · the technique grant
and `holdsTechniqueGrant` · both providers' widest and per-kind levels · the
category verdict for 18 tools · and **every declared gate's verdict, rule,
reason, blocked message, errorCode, resource and audit name across 18 calls**.

```
agents compared  : 113
dimension rows   : 7,345
BASE vs BASE (the flake control, same commit, same DB) : 0 diffs
BASE vs A6                                             : 0 diffs
agents differing                                       : 0
```

**EMPTY, INCLUDING THE TWO TERMINATED EXEMPLARS A5 MOVED.** It is empty by
construction as well as by measurement: A6 changes no server module that any
door reads. The only server file it touches is `agent/access/presets.ts`, and
only the four `description` strings — a route payload, not a capability.

**The owner's live rows were not touched.** Re-read at the end of the task: 113
agents, the seven live ones exactly as A4/A5 left them (`Kevin master=1`,
`BehaviorBot master=0`, the five other built-ins `master=null`, every one
`categories='*'`, `techniques` NULL on all of them). The probe, the Playwright
run and the refusal drive all ran against a `.db` copy with `HOME` redirected;
that copy, and the scratch `HOME` beside it, are deleted.

---

## 4. THE FOLD: WHAT MOVED, WHAT STAYED, AND WHY

The brief asked for a census of the agent editor's remaining permission-ish
toggles, the grantable ones moved with one plain sentence each, the emptied
cards removed, and anything not truly per-agent-grantable named here.

### 4.1 MOVED — fourteen toggles, into three rows

| old control | new label | row | storage (UNCHANGED) |
|---|---|---|---|
| Web Search | Search the web | reach | `tools_policy.deny` ∋ `web_search`,`web_fetch` |
| Web Browsing (+ domains) | Open web pages (+ Any website / Only these) | reach | `system_control` ∋ `web_browse`, `tools_policy.deny`, `network_domains` |
| Run Terminal Commands (+ list) | **Run programs on this Mac** ⚠ (+ Any command / Only these) | reach | `exec_allow` |
| Share User Profile | Knows who you are | knows | `config.shareUserProfile` |
| Read Files (+ scope) | Read your files (+ Anywhere / Only these folders) | manage | `file_read` |
| Write Files (+ scope) | Change and create files | manage | `file_write` |
| Delete Files (+ scope) | **Delete files** ⚠ | manage | `file_delete` |
| View the Screen | See your screen | manage | `system_control` ∋ `screen` |
| Control the Mouse | Move the mouse | manage | `system_control` ∋ `mouse` |
| Control the Keyboard | Type on the keyboard | manage | `system_control` ∋ `keyboard` |
| Run AppleScripts | **Automate Mac apps** ⚠ | manage | `system_control` ∋ `applescript` |
| Create Sub-Agents | Create helper agents | manage | `can_spawn_agents` |
| Assign Permissions | **Set what other agents may do** ⚠ | manage | `can_assign_permissions` |
| Blocked Commands | Commands it may never run | manage ▸ Advanced | `exec_deny` |
| Max Processes | Programs it may run at once | manage ▸ Advanced | `max_processes` |
| Allowed Tools (raw) | Tools it may use, by name | manage ▸ Advanced | `tools_policy.allow` |
| Denied Tools (raw) | Tools it may never use, by name | manage ▸ Advanced | `tools_policy.deny` |

**"Knows who you are" is the one placement that is not the brief's literal
reading, and it is named rather than smuggled.** The brief folds the legacy
toggles into row five; this one answers row four's question exactly — *what it
knows* — so it sits there, above the techniques, and row five is left as "what
it may act on".

**The `Permissions` card is deleted**, both branches — the editor and the note.
`AgentConfigPanel.tsx` went 452 → **392** lines with it.

### 4.2 DELETED — one control that was a second copy

**"Network Domains (raw)"** in the old Advanced block wrote `network_domains`,
the field the *Open web pages* scope above it already owns. Two controls over one
field can disagree on screen, which means one of them is lying; the one that
survives is the one labelled in words the owner can act on.

### 4.3 STAYED — named, with the reason

1. **The Memory card ("Skip in Dreamer cycle", `dreamerIgnore`).** Not a grant
   this agent holds: it governs what *another* agent (the Dreamer) does with this
   agent's conversations. Nothing about what this agent may reach. Left on its
   own card, unchanged.
2. **Name / Model / Classification / System Prompt.** Identity and configuration,
   not access. Untouched, and asserted untouched.
3. **`PermissionsEditor.tsx` itself, still mounted by the CREATE-AN-AGENT modal**
   (`pages/Agents.tsx`). At creation there is no agent row and therefore no
   Access panel to fold into, so it is the only control there. **Named here and
   pinned by a test clause** rather than left as a quiet leftover — a component
   with one remaining caller is exactly the thing that starts drifting from the
   surface that replaced it. The obvious next step, not taken unilaterally: give
   the create modal the same five rows.
4. **`tools.allow` still RESTRICTS rather than grants** (census C2/G2, carried
   from A1 §6.3 through A5 §10.6). A6 surfaces the field in plain words in the
   Advanced disclosure; what it MEANS is unchanged and stays an owner decision.

### 4.4 THE FOLD IS A REPOINTING, AND THAT IS A TEST

`lib/manifest-edits.ts` is the old editor's twenty `useState` hooks as one object
and its `buildOutput` as one function. The load-bearing clause is an **identity**:
for every stored shape, `buildLegacyAccess(readLegacyAccess(x))` is the document
`PermissionsEditor.buildOutput` produced from the same `x` — same ten keys, same
derivations, byte for byte. Two consequences that are also tests:

- **Opening the panel is never dirty**, so a save that touches only the grants
  half never rewrites the manifest and never writes an audit row for it.
- **No key the old editor did not write is written.** `shell_allow` and the
  artifact paths are still absent, and the manifest reader still fills them the
  way it always has.

**Nothing was migrated and nothing was re-keyed, so the brief's "stop and
propose" clause was never reached.**

---

## 5. THREE DEFECTS FOUND WHILE PORTING, FIXED WITH THEIR CLAUSE BESIDE THEM

1. **THE WEB TOGGLES WERE ONE-WAY.** `rawToolsDeny` was seeded from the STORED
   deny list — which already held `web_search` when the toggle was off — and the
   build merged it back in. So *Web Search* could be switched OFF and **never on
   again** except by hand-editing the raw Advanced field. The Advanced field now
   carries only the denies no toggle owns; the toggle works in both directions,
   and `build(read(x))` is unchanged for every stored `x`.
2. **THE DELETE SUB-OPTION SAID "All files" AND WROTE `['/tmp/**']`.** The write
   is untouched; the label ("The temporary folder") and the read-back now agree
   with it, so the control round-trips honestly.
3. **THE "OPERATOR" PRESET CLAIMED SOMETHING A PRESET CANNOT GRANT** (§2.3).

And one the Playwright drive found, which is the `548e5f8f` rider:

4. **THE EXEC SWITCH GOES ON WITH AN EMPTY COMMAND LIST, AND AN EMPTY
   `exec_allow` GRANTS NOTHING.** Driven: the switch went on, Save was pressed,
   the stored value came back `[]`, and the row's state line had said
   "programs". The storage rule is correct and untouched; the panel now reports
   the **value** (`legacyReachSummary` asks `buildLegacyAccess`) and the row says
   the gap out loud — *"No commands listed yet, so this grants nothing until you
   name some."*

---

## 6. PROMPT BYTES: ZERO, AND IT WAS MEASURED

```
check-cache-prefix       exit 0   prefix byte-invariant across 9 turn-states, kevin (system 35,776 chars)
check-prompt-inventory   exit 0   24 system + 12 message entries, exact roster + slot order pinned
check-steer-delivery     exit 0   the engine steer reached the model
check-message-prefix     exit 0   judged, driven by the check
check-prefix-holds-still exit 0   TAIL HELD — divergence only at REGISTERED deliberate blocks
check-assembled-context  exit 0   9 turn-states, two assembles each and identical
check-reanswer-ghost     exit 0   LAW HOLDS — 54 in, 54 out
check-roster-conformance exit 0   9 checkers, all named

✓ prompt-gate record accepted — 8 blocking gate(s) green, 0 acknowledged red(s), at 548e5f8f
```

**8/8, NO GOLDEN RE-BLESSED, no `--update` anywhere.** `check-cache-prefix`
reports kevin's system prompt at **35,776 characters — the same value W77
recorded**. A6 ships dashboard code, four preset description strings and tests;
it adds no tool, no tool-schema field and no prompt slot.

Instruments installed once and **uninstalled and verified clean** (0
`[DEV-INSTRUMENTS]` markers in `packages/`).

---

## 7. DRIVEN — THE WHOLE PANEL, IN A REAL BROWSER (Playwright)

Real routers (`createServer()`) + the real built dashboard + a **copy** of the
owner's database with `HOME` redirected. Deliberately **not** a second platform
boot: `index.ts` is never imported, so no poller, no Healer, no bridge — a second
process holding the owner's rows must not be able to reach a person. The scratch
`HOME`'s `secrets.yaml` was replaced with a throwaway one, so **no provider token
of the owner's was copied into the harness**.

### 7.1 The digest, three differently-configured agents

Each expectation is computed **independently in the drive script from the stored
row**, not imported from the module under test:

```
kevin        "Full tools · talks to you and approved contacts · 6 connections"          MATCH
behaviorbot  "Full tools · talks to no one · 6 connections · runs programs"             MATCH
narrow       "3 tool groups · talks to you only · 2 connections"                        MATCH
                rows rendered while collapsed: 0   (all three)
```

### 7.2 All five rows, collapse and expand

```
CARD EXPANDED  rows: 5
  "What it can do"      open=false  state="3 tool groups"
  "What it can reach"   open=false  state="Plaud, 1 account"
  "Who it can talk to"  open=false  state="You only, on iMessage"
  "What it knows"       open=false  state="No techniques"
  "What it may manage"  open=false  state="Your files"
  EXPAND/COLLAPSE each of the five: aria-expanded true→false, bodies on card 1→0, five for five
```

### 7.3 The moved legacy toggles round-trip

The narrow agent was **created through the real panel door** (`POST /api/agents`)
and **torn down through the real deletion door**.

```
STORED before  exec_allow=[]  deny=["web_search","web_fetch","web_browse"]  spawn=false  shareUserProfile=false

  programs switch on, list still empty — row says: "Plaud, 1 account"      ← the rider, working
  and the row says so on screen: true
  after naming two commands, row says: "Plaud, 1 account, programs"

MANAGE row state now: "Your files, this Mac, other agents"
KNOWS  row state now: "No techniques, knows who you are"
risky rows on screen: 2

SAVE enabled: true
STORED after   exec_allow=["ls","cat"]  deny=["web_browse"]  spawn=true
               system_control=["screen"]  shareUserProfile=true
GRANTS UNTOUCHED apart from tools.deny: true
  tools.deny before/after (A3's toolsPolicy fold): ["web_search","web_fetch","web_browse"] -> ["web_browse"]

RE-OPEN digest: "3 tool groups · talks to you only · 2 connections · runs programs"
  "What it can reach"  state="Plaud, 1 account, the web, programs"
  "What it may manage" state="Your files, this Mac, other agents"
  "What it knows"      state="No techniques, knows who you are"
  ROUND TRIP  Create helper agents      aria-checked=true
  ROUND TRIP  See your screen           aria-checked=true
  ROUND TRIP  Read your files           aria-checked=true
  ROUND TRIP  Run programs on this Mac  aria-checked=true
  ROUND TRIP  Search the web            aria-checked=true
  ROUND TRIP  Open web pages            aria-checked=false
  ROUND TRIP  Use stored keys & logins  aria-checked=false
  ROUND TRIP  Plaud recordings          aria-checked=true
SAVE disabled (nothing dirty): true
```

The one grant that moves is `tools.deny`, and that is **A3's `toolsPolicy` fold
doing its job** — the owner turned *Search the web* on, so its deny left. Every
other leaf of the grants object is byte-identical across a manifest-only save.

### 7.4 A built-in agent

```
KELLY  rows: 5
  "Who it can talk to"  state="Through your main agent"
  "What it may manage"  state="Set by the dojo"
  TALK body:   "This is a helper agent that talks through your main agent, so it has
                no switch of its own. Everything else here is still yours to set."
  "Can talk to people" switches in that row: 0        ← ruling 1, on screen
  MANAGE body: "This is one of the dojo's built-in agents. Its file, command and
                system-control settings are set by the dojo and are not changed from here."
  editable controls in that row: 0
  REACH body has the built-in note: true
  switches in the reach row (the GRANTS half stays editable): 6
```

Today's rule is carried across exactly — the old card rendered a note instead of
the editor for every platform agent — and **the panel never learns a rank to do
it**: `manifestEditable` is one prop, decided by the page, which is the thing
that knows which agent is the main one. `AccessPanel.tsx` still contains no
occurrence of `classification`, which is A3's clause, unweakened.

**Screenshots** (16): `/tmp/a6-1-digest-kevin.png` · `a6-1-digest-behaviorbot` ·
`a6-1-digest-narrow` · `a6-2-rows-all-folded` · `a6-2-row-1` … `a6-2-row-5` ·
`a6-3-reach-open` · `a6-3-reach-edited` · `a6-3-manage-edited` · `a6-3-saved` ·
`a6-4-reopened` · `a6-5-builtin` · `a6-6-fully-open`.

---

## 8. RED FIRST, THE TEST ESTATE, AND GATE-SIDE

Run in this tree at `9184d6cf` before a line of implementation:

```
the-panel-speaks-plainly.test.ts — did not collect
  Cannot find module '.../dashboard/src/lib/manifest-edits.js'
  (and: accessDigest is not exported; AccessPanel.tsx carries four titled
   sections and no questions; AgentConfigPanel.tsx imports PermissionsEditor)
```

New: `the-panel-speaks-plainly.test.ts` (**39**). It drives the digest and the
five row summaries as functions, drives the fold's identity against a stored
shape, and censuses the React shape the Playwright run then exercises. The
language rule is measured on the source **with comments stripped**, so a
tombstone comment naming the old behaviour can neither satisfy nor break a
clause about what the owner reads.

**Six clauses in two existing files were edited, and only where they pinned a
LABEL.** In each the requirement survives and is restated in the file:

- `the-access-panel.test.ts` — the four section TITLES become the owner's five
  QUESTIONS (every section the plan named still exists, now named by what it is
  for); `"Allowed to talk to humans"` → `"Can talk to people"`; the
  `/grants:/` source match becomes `body.grants = patch` + `grantsPatch(stored,
  draft)`, because A6 sends one PUT carrying up to two halves; and the
  helper-agent note now asserts `talks through your main agent` **plus** that the
  rank word is gone.
- `the-panel-reveals-its-children.test.ts` — `"Access to stored credentials"` →
  `"Use stored keys & logins"` and `"Technique access"` → `"Can use techniques"`.
  One control over the whole field, and a switch that reveals its list, are both
  unchanged; what moved is the sentence on them.

### Gate-side

- **The pins are their own commit** (`8be2b03c`), no product code, and **none of
  the four is a raise** — every new file is under `maxNewFileLines` (400) and
  under the growth gate's 240 crossing line, so all four were already legal twice
  over. They are pinned for PHASE-6 T1's stated reason.

  ```
  AccessControls.tsx  141   the shapes both callers draw
  AccessManifest.tsx  239   the deleted Permissions card as rows two and five
  manifest-edits.ts   205   the pure half of the fold
  access-summary.ts   113   the digest and the five row state lines
  ```

- **NO EXISTING RATCHET WAS RAISED.** `AccessPanel.tsx` held at **436 against its
  437 pin**, `access-edits.ts` is untouched at **314**, and
  `AgentConfigPanel.tsx` **shrank 452 → 392**. `access-summary.ts` exists
  precisely because `access-edits.ts`'s entry says, in three separate raises,
  that it may only shrink: putting the words there would have taken it to 418.
  The first draft did exactly that, the ratchet refused, and the refusal was
  right.
- **Report-tier reds are the same two A1–A5 recorded.** `capability-ledger`'s one
  missing capability (`job pm-agent:startPokeLoop#2`) — A6 adds no route and no
  job, so there is no undeclared capability — and `deletion-ratio` refusing
  because the tree is dirty, the only untracked file being **W72's own census
  report**, which I did not commit (it is not mine).
- **CSS:** `.acx-section` / `__title` / `__desc` deleted with the always-open
  headings they drew; `.acx-row*`, `.acx-item*`, `.acx-adv*`, `.acx-list` and
  `.acx-count` added, each with the rule it enforces written beside it.
- The growth baseline still prints its 35-day staleness warning. Pre-existing;
  re-recording widens the tolerance for 649 files at once and is an owner-visible
  decision, not a worker's.
- **Nothing left running.** Harness stopped, port 3988 free, worktree removed and
  pruned, the temp probe/harness/drive scripts deleted from the tree, the scratch
  `HOME` (including the database copy) deleted. The owner's `tsx watch` dev server
  (pid 13224) was up before this task, is healthy, and is serving the branch.

---

## 9. NOT IN A6 — recorded, not done

1. **The create-an-agent modal still uses the old `PermissionsEditor`** (§4.3).
   Giving it the same five rows is the obvious next step and was not taken
   unilaterally — it is a second surface with its own defaults (`DEFAULT_SUBAGENT_*`),
   and folding it is a decision about what a NEW agent starts as, which is
   ruling 2's territory.
2. **`tools.allow` still restricts rather than grants** (§4.3).
3. **The refusal wording on ladder row 7 is still unchanged** — the SIXTH time
   this is handed up (A1 → A3 → A4 → A5 → here). Untouched for A5's reason: a
   message delta would land in the capability diff this phase's proof rests on.
4. **`renderMessageSources` is still unconditional for every agent** (A4 §10.2),
   and **`renderGoogleAccess` / `renderMsAccess` still assert about OTHER agents**
   (A4 §10.3). Untouched.
5. **Per-kind Workspace filtering at the SURFACE is still coarse** (A1 §6.6).
6. **A non-primary built-in agent's MANIFEST is still not editable**, and
   `update_agent` / `get_agent_profile` are still `PRIMARY_ONLY_TOOLS` (A3
   §7.4–7.5). A6 keeps the rule and only makes it say so in plain words.
7. **A4's two terminated exemplar rows are still on the box.** Untouched; they
   are in the 113 and they diff empty.
8. **The digest counts CONNECTED ACCOUNTS by kind, not by account row.** That is
   exact for anything the panel has written (`setAccountLevel` keeps the kind
   level equal to the widest account of that kind) and is stated in the module.
   An agent whose per-account overrides were written by a MODEL through
   `update_agent` could in principle disagree; making the digest per-account
   would mean the folded card could not render before the accounts fetch
   resolves, which is a worse lie than the one it fixes.

---

## 10. REPORT PATH

`.superpowers/sdd/UX-REPAIR/task-W78-report.md` (this file). Branch tip
`8be2b03c`, three commits ahead of `9184d6cf`, nothing pushed.
