# LANE 2 — THE STOP-TRUTH PAIR (BACKLOG A-5b + A-6)

**STATUS: BOTH SHIPPED on `t86-lane2`, five commits, 27 new clauses, 12 mutants all killing.
Two decrease-only pins need a +3 raise each — argued below, NOT taken (this hour's rule).
Everything else in `npm run gates` is green, including the names gate over the shipped labels.**

| | |
|---|---|
| branch | `t86-lane2`, based on `791467ff` |
| A-6 product | **`ab96ce18`** — the stop button reaches the web and workspace transports too |
| A-6 tests | **`5388b8be`** — the next tool cannot be born stop-blind (15 clauses, census) |
| A-5b product | **`61d64da8`** — the stop button appears for the work it can already stop |
| A-5b tests | **`1cd49bae`** — the route and the rule checked against each other (12 clauses) |
| size answer | **`74e8681e`** — the html shaper leaves `web-tools.ts`; the two pin raises argued |
| not touched | `ratchets.json` · `gate-manifest.mjs` · `definitions.ts` · the live dev server · `~/.dojo` · the kit |

---

## 1. A-6 — the transports answer to the stop

The ledger line was *"web_fetch/site-snapshot and the Microsoft/Google transport calls have the
same old stop-blindness the media dials had; the fix machinery (openAgentCall) is built and
waiting"*. Four `fetch` sites, each carrying nothing but its own flat clock, so a stop pressed
while a page, a Graph read or a Drive upload was on the wire found an empty registry and cut
nothing.

| Site | Scope | How |
|---|---|---|
| `agent/web-tools.ts` — `web_search` | `turn` | slot opens INSIDE the rate-limit queue, so a call still waiting behind the 1.1 s limiter is not reported as in flight |
| `agent/web-tools.ts` — `web_fetch` | `turn` | ONE slot for the whole 5-hop redirect loop; released at the end of the TRANSPORT, because what follows is the prompt-extraction model call that registers its own slot through `callModel` |
| `agent/site-snapshot.ts` — `isEmbeddable` | `turn` | agentId threaded from `cat/canvas.ts`; a stop at the door answers "let the iframe try" rather than sending a just-stopped agent to the heavier screenshot path |
| `google/client.ts` / `microsoft/client.ts` | `turn` | optional trailing `agentId` on the private transport, passed by every public wrapper (`googleRead`/`googleWrite`/`googleSilentFetch`, `msGraphRead`/`msGraphWrite`) — every existing call site keeps compiling |

Plus the one caller in the family that is **not** a `fetch`: `captureSiteScreenshot` renders in
Playwright, whose `goto` takes no `AbortSignal`, so the stop is **enacted** — the slot's signal
closes the browser context, which rejects the in-flight navigation.

**The clock is composed, never replaced**, so a slow page still times out as a page; and the
identity is read off the call's OWN controller, which is what stops a 15 s deadline from wearing
the user's name. That mattered here rather than in theory: `web-tools.ts` owns a friendly-error
ladder that turns an `AbortError` into *"Couldn't reach <url> — request timed out. The server is
slow or unresponsive."* A stop used to come out of this tool wearing that sentence.

**The ownerless call was a decision, not an oversight.** A transport call with no `agentId` is
platform plumbing (a token refresh, a boot probe) and dials exactly as before rather than
inventing an owner — because A-5b turns `countAbortable` into something a **user reads**, and a
registration for work no agent asked for would make that number a lie. §3's second clause pins it:
an ownerless call dials, and registers against nobody.

## 2. THE CENSUS — the tally you asked for

`packages/server/src/agent/__tests__/no-transport-is-born-stop-blind.test.ts` §7. Every production
`.ts` under `packages/server/src` (tests excluded, **comments stripped** so a `fetch(` in a tool
description is not a call) must either contain `openAgentCall(` or carry a written exemption.

**WIRED: 5 · EXEMPT: 26 · UNACCOUNTED: 0**

| Wired (5) | |
|---|---|
| `agent/model.ts` | the model transport — T83 registered it directly, before this door existed |
| `agent/web-tools.ts` · `agent/site-snapshot.ts` · `google/client.ts` · `microsoft/client.ts` | this lane |

*(the four media dials — `image-`/`audio-`/`video-generation.ts`, `transcription.ts`, plus
`video-job-poller.ts` — ride `openAgentCall` too and are held by A-5's own census next door; they
are not `fetch`-bearing by this walk's reading because their dials sit behind helpers.)*

| Exempt, by KIND — and the kind is the argument, not the file name | Count |
|---|---|
| **NO AGENT EXISTS** — an operator in Settings, a boot probe, a price index on a timer, an OAuth token exchange, the updater, a local model pull: `gateway/routes/{config,setup-deps,system,update}.ts`, `github/device-flow.ts`, `google/auth.ts`, `microsoft/auth.ts`, `services/{capabilities,litellm-pricing-sync,pricing-sync,num-ctx-calculator,ollama}.ts`, `update/artifact-integrity.ts`, `voice/model-manager.ts` | 14 |
| **THE CALL IS THE DELIVERY** — an SMS already committed, the issue POST behind the owner's own Post button: `twilio/client.ts`, `github/issues.ts` | 2 |
| **THE AGENT IS NOT WAITING** — a webhook ack, the live-voice turn detector and transcriber, the corpus embedder: `twilio/sms-inbound.ts`, `voice/{smart-turn,stt-service}.ts`, `memory/embeddings.ts` | 4 |
| **RIDES THE DOOR ALREADY** — Graph/Drive traffic goes through the wrapped transports; the bare `fetch` left is a byte-read off a URL the API just issued: `google/tools-slides.ts`, `microsoft/tools-{office,read,write}.ts` | 4 |
| **NOT A CALL** — the string appears in a tool DESCRIPTION the model reads: `agent/tools/definitions.ts` | 1 |
| **ALREADY HELD ELSEWHERE** — `agent/model.ts` is listed here too, as the one caller that had the property before the door existed | 1 |

The table is **exact in both directions**: a stale row fails the suite, and an exemption under 40
characters fails as well — "same" is not an argument. And the four wired files are named in a
separate clause, so the census cannot be satisfied by exempting the fix.

## 3. A-5b — the button appears for work it can stop

The defect is a consequence of A-5's own correct decision: a background media job **outlives its
turn** (the image delivery waits for idle; the video poller runs up to thirty minutes), so the row
reads `status: 'idle'` while work is on the wire — and the card gated Stop on `status === 'working'`.
The button was withheld for exactly the work it would have cut.

- **Route predicate**: `AgentDetail.inFlight = { turn, background }`, read live off the abort
  registry via `countAbortable` in `rowToAgentDetail`. No column, no writer, no frame — and a
  source clause asserts the route names neither `registerAbortable` nor `abortInFlight`, so it
  cannot become a third writer for state A-5's census keeps at two.
- **Dashboard affordance**: `packages/dashboard/src/lib/stop-affordance.ts`, a pure rule in the
  lib directory (the established no-test-runner pattern — eight other lib files are driven from
  the server suite). `AgentCard` asks it instead of keeping its own predicate.
- **The rule**: working ⇒ stoppable (unchanged, *including on a payload with no `inFlight` at
  all*); background > 0 ⇒ stoppable, labelled "Stop background job(s)" with a reason line;
  terminated ⇒ never; idle-with-a-turn-call ⇒ stoppable, because the status write and the registry
  are not one transaction and there IS a call to cut.

⚠ **What I did not decide.** The BACKLOG entry also asks for *"an owner ruling on what stopping an
idle agent means for its proactive lane"*. That is a product ruling, not a rendering rule, and it is
not invented here — nothing in this change touches the scheduler. **It is still open.**

⚠ **The other half of the surface, honestly stated.** The Chat composer's stop is driven by
`agent:status` ws frames, not by this payload, so a background job that starts after a turn ends
produces no frame and the composer still shows nothing. Making that appear needs either a frame
when a background job opens/closes or a poll of this field — a new emission either way, which is
more than a rendering rule and was not in scope for the hour. **The agent card now tells the truth;
the composer does not yet.**

## 4. Mutants — 12, all killing, each reverted with sha256 re-asserted

| A-6 | | |
|---|---|---|
| MA1 | `web_fetch` handed a bare clock again | **2 F** — "the page request was not cut" + the bare-clock census line |
| MA2 | the stop's identity deleted from the catch | **1 F** — the ladder's "Web fetch of … failed" reaches the agent |
| MA3 | the Google slot removed | **2 F** — "the Graph/Drive request was not cut" |
| MA4 | Microsoft stops naming the stop | **1 F** — "This operation was aborted" as the error |
| MA5 | the Google slot never released | **1 F** — "a transport leaked its registration" |
| MA6 | **a brand-new stop-blind tool arrives** | **1 F** — the census names `services/mutant-newtool.ts` |

| A-5b | | |
|---|---|---|
| MB1 | the route hardcodes zeros | **4 F** — "the background job is invisible to the dashboard" + "route and rule disagree" |
| MB2 | the rule's background branch deleted | **3 F** — "the button is still withheld for background work — the A-5b defect" |
| MB3 | a terminated agent offered a stop | **1 F** |
| MB4 | `isWorking` put back on the button | **1 F** — "the old `isWorking` gate is back" |
| MB5 | absent counts read as zero | **2 F** — "a working agent lost its button" |
| MB6 | the route conflates the two scopes | **1 F** — background 3 where 2 is the truth |

MA6 and MB5 are the two worth remembering: MA6 is the census earning its keep (the NEXT tool cannot
be born blind), and MB5 is the obvious-but-wrong way to write the rule — requiring a positive count
silently removes the working button on every not-yet-updated server.

## 5. THE TWO PIN RAISES — argued, not taken

`npm run gates` refuses on exactly two decrease-only pins. I did not edit `ratchets.json`.

```
packages/shared/src/types.ts                   pinned 631 → 634   +3
packages/server/src/gateway/routes/agents.ts   pinned 977 → 980   +3
```

**`types.ts` (+3)**: one line of code (`inFlight?: { turn: number; background: number }`) and a
two-line comment carrying the one distinction a reader must not lose — `undefined` means "no
claim", never zero, which is the difference mutant MB5 measures. It cannot live anywhere else: it
is the wire shape both halves read, and the dashboard imports `AgentDetail` from this file.

**`agents.ts` (+3)**: one import, one comment line, one field line. Two alternatives measured and
refused: a helper in an unpinned file still costs the import plus a changed return line and **any**
growth fails a decrease-only pin, so it would buy nothing and add a hop; and moving the payload
builder out of the route to dodge a number is the accounting the gate exists to prevent.

The third size refusal — `web-tools.ts` at 432 over the 400-line new-file cap — I fixed rather than
argued: the search's slot stopped needing an extracted helper (−25), and `stripHtmlTags` moved to
`agent/html-text.ts` (38 lines). That split is a seam, not arithmetic: everything left in
`web-tools.ts` DIALS — permissions, redirects, a rate limiter, an agent's stop — and the HTML shaper
is a pure string transform with no network, no clock and no agent in it. **432 → 381.**

## 6. Verification

| | |
|---|---|
| A-6 suite | **15 clauses green** |
| A-5b suite | **12 clauses green** |
| both + the two existing stop suites (media dials, the stop button itself) | **4 files, 70 clauses, 0 failed** |
| `npm run typecheck` | clean (shared + server) |
| eslint over the changed files | clean (1 pre-existing floating-promise warning in `site-snapshot.ts`'s own code path, unrelated to this change — see concern 3) |
| `npm run gates` | 13 of 15 blocking green; the two refusals are the pins above. Names gate green over the shipped labels ("Stop", "Stop background job(s)" — no name in either) |
| full server suite | **478 files, 7,175 clauses, 0 failed, exit 0** — on a quiet box. An earlier run showed 2 failures; that was my own fault and is now measured, see concern 1 |

All measured in the lane worktree (`node_modules` symlinked from the main tree with `@dojo/shared`
shadowed to this worktree's copy, because the workspace symlink otherwise resolves the other lane's
`packages/shared`). The live dev server, `~/.dojo` and the kit were never touched.

## 7. Concerns

1. **RESOLVED, and worth recording because I nearly reported it wrong.** A first full-suite run on
   this branch showed 2 failures — `a-stop-stops-the-media-generators` (§2's CONTROL clause,
   `expected 'running' to be 'failed'`) and `a-rename-reaches-the-soul` (`ENOENT` writing
   `SOUL.md` into its own throwaway home). Neither is a regression, and the proof is three
   measurements rather than an argument: the BASE commit's full suite is green (476 files / 7,148);
   both files are green run alone (52 clauses); and a re-run of the full suite on THIS branch with
   nothing else on the box is green (**478 files / 7,175, exit 0**). The cause was mine: I had
   `npm run gates`, two other vitest invocations and two `tsc` builds running CONCURRENTLY with
   that first suite run, and the log carries the signature — `[vitest-worker]: Timeout calling
   "onTaskUpdate"`. Both failures are timing-shaped (a job not yet terminal, a temp home not yet
   created). ⚠ THE STANDING LESSON, not a finding about this lane: those two clauses are
   load-sensitive, so a busy CI box can go red on them without anything being wrong — worth a
   ledger line for whoever owns flake budget.
2. **The Chat composer half of A-5b is not done** (§3). The card tells the truth; the composer needs
   an emission, which is a bigger surface than a rendering rule.
3. **One eslint warning I introduced and left**: the Playwright context-close on abort is a
   deliberate fire-and-forget (`void context.close().catch(() => {})`) inside an event listener;
   the rule wants a `.then` rejection handler on the outer expression. Left as a warning rather than
   restructuring the listener, because the `catch` is already there — flagged here rather than
   silenced.
4. **`countAbortable` is now a user-visible number.** Anything that registers a slot for work that
   is not on the wire will show a Stop button for nothing. The A-6 wiring already respects that (the
   search's slot opens inside the queue; `web_fetch` releases at the end of its transport), and §6's
   "registry is empty after a clean call" clause is the standing guard — but it is a new obligation
   on every future caller of the door, and it belongs in whatever document the next implementer
   reads.
5. **`site-snapshot.ts`'s screenshot path is enacted, not composed.** Closing the context rejects
   the navigation, which is the right lever, but it is a different mechanism from every other site
   in the census — and the census greps for `openAgentCall(`, so it counts as wired without checking
   that the lever works. The behavioural clause covers the probe (`isEmbeddable`), not the capture:
   proving the capture needs a real headless browser, which is a live-verification follow-up.

---

# APPENDIX — FIX ROUND (sweep review B: L2-1, L2-2, L2-3, L2-4 + the L6 folds)

**STATUS: all four lane-2 findings closed at the root, both L6 folds done. RV1 — the mutant that
rode 27/27 GREEN — now goes 3 F / 18 P. One size refusal left, argued not taken.**

| | |
|---|---|
| branch | `t86-lane2fix`, off the merged tip `e83674d6` |
| product | **`4dd729f4`** the 32 Graph calls the census called handled are handled now · **`c829bb6a`** the embedder's wiring shrinks to six lines |
| test-side | **`7b38d7c8`** an exemption stops being immunity, and the scheduler premise gets its pin · **`01e57745`** two existing guards fired on this round's own work |
| untouched | `ratchets.json` · `growth-baseline.json` · `gate-manifest.mjs` · `definitions.ts` · the dev server · `~/.dojo` · the kit |

## A1 — L2-1 (HIGH): the three false exemptions are wired, not reworded

The reviewer measured what *"RIDES THE DOOR ALREADY"* was worth: `tools-office.ts` called **neither
wrapper anywhere** — 13 bare fetches, 9 straight to Graph, **11 with no `signal` at all** — reached
from `cat/office.ts:105` with the agentId in hand and unused. `tools-write.ts`'s sentence described 4
of 16 sites; `tools-read.ts`'s described none of 3.

**`microsoft/graph-fetch.ts`** is the door those 32 calls now take: the agent's stop through
`openAgentCall`, composed with whatever clock the caller brought, plus a finite clock for the eleven
that had none — and deliberately **none** of the three things the wrapped door adds (activity row,
outbound record, broadcast), which is the whole reason those calls were not simply rewritten to use
`msGraphRead`. A stop is re-labelled as a stop once, at the door, because these callers render their
own failure text and an `AbortError` reaching them comes out as a transport fault.

**It cost ZERO lines in all three pinned files** (3508 / 1631 / 2212, unchanged), and that is
mechanism rather than accounting: `agentId` is the door's FIRST parameter so 32 multi-line
`fetch(url, {…})` sites became `graphFetch(agentId, url, {…})` as a prefix edit; `tools-office.ts`'s
own `const GRAPH_BASE` was a **second copy** of the literal in `client.ts:16`, so the new module owns
the constant and that deletion paid for the import; the other two gained a NAME on an import line
they already had. `agentId` is threaded through the four byte helpers and the three-deep attachment
chain, each on an existing line.

## A2 — L2-2 (HIGH): the exemption mechanism is no longer immunity

`FETCH_SITES` pins the number of `fetch(` sites in **every** fetch-bearing file — wired and exempt
alike — and three clauses read it: an unpinned file that gained its first fetch fails, a changed
count fails, and a pinned row for a file that no longer fetches fails. **An exemption is an argument
about the calls that exist; it is not a licence for the next one.**

| mutant | before this round | now |
|---|---|---|
| **RV1** — the reviewer's clockless, unregistered Graph fetch in `tools-office.ts` | **0 F — 27/27 GREEN** | **3 F / 18 P** — the bare-Graph clause, the registration clause, and the count pin |
| **RV1b** — the same shape in a file that is STILL exempt (`voice/smart-turn.ts`) | would have been green | **1 F / 20 P** on the count pin — the finding's general form, not its one instance |

RV1's final re-plant at the finished tree, reverted byte-exact, sha256
`ff6953485d592d6faa146c4ff05bd429cdc36ce37c56eb3e1746c9815994bab5`.

## A3 — L2-3 / L2-4

**L2-3**: `generateEmbedding` takes an optional `agentId`, composes the stop with its own timeout on
both dials, and releases by identity across the halving retries. The seven awaiting callers the
reviewer named hand over the agent they hold (`recall-lane`, `vector-search`, `vault_search`, four
`a2a-transport` sites — the a2a ones attribute the wait to the **sender**, whose turn is doing the
send). The corpus sweep passes nothing and is unchanged, so the exemption's true half survives as
behaviour instead of prose.

⚠ **A mutant caught a hole in my own first clause.** Deleting the `finally` passed, because
`abortInFlight` **deletes** each controller as it aborts it — after a stop the count is 0 whether the
caller released or not. The leak now dies on a separate clean-call clause. The stake is A-5b: a
registration that outlives its work renders as a Stop button for work that is over.

**L2-4**: `twilio/client.ts`'s exemption now names both kinds (the `sendSms` delivery and the
`testTwilioCredentials` operator-in-Settings), with a clause asserting both appear, so the next call
added to that file cannot inherit the wrong argument.

## A4 — the final tally

**WIRED: 9 · EXEMPT: 22 · UNACCOUNTED: 0 · every one of the 32 files' fetch-site counts pinned.**

| | |
|---|---|
| **wired (9)** | `agent/model.ts` · `agent/web-tools.ts` · `agent/site-snapshot.ts` · `google/client.ts` · `microsoft/client.ts` · **`microsoft/graph-fetch.ts`** · **`microsoft/tools-office.ts`** · **`microsoft/tools-read.ts`** · **`microsoft/tools-write.ts`** · **`memory/embeddings.ts`** (the last five new this round; `tools-office`/`tools-read` no longer contain a bare `fetch(` at all) |
| **exempt (22)** | 13 NO AGENT EXISTS · 2 THE CALL IS THE DELIVERY (one of them now stating both of its kinds) · 4 THE AGENT IS NOT WAITING · 1 RIDES THE DOOR ALREADY (`google/tools-slides.ts`, the one the reviewer measured as TRUE) · 1 NOT A CALL · 1 already-held-elsewhere |

## A5 — the L6 folds

**L6-1**: lane 6's report now carries both M2 numbers and says which is the evidence — 19F at the
inner plant, **26F / 212P** at the exported predicate (the reviewer's plant, which short-circuits the
`interAgentTurn` and `surfacedReplyThisTurn` guards as well) — and states plainly that the
**load-bearing proof of §2 is the Option-A run with its five named controls**, not `return true`. A
mutant that widens a predicate to every turn cannot distinguish "the ruling was overturned" from
"the shape broke".

**L6-2**: a new three-clause pin,
`preflight/__tests__/a-scheduler-cycle-has-no-continuation.test.ts`. The continuation record has
exactly **one** writer in the engine corpus and it is the C3 human stash; that write is guarded by a
human conversation being chosen; and the predicate still requires the record to exist and is still
free of any name or display-kind. Mutants: a second writer on a background path → RED; the
`!!continuation` conjunct dropped → RED; the `chosenConvKey` guard removed → RED.

## A6 — two existing guards fired on this round, and both were right

The closure manifest refused `microsoft/graph-fetch.ts` by name until the reading was written beside
it (the reach is unchanged — the door enters through `client.ts`, which was already in the manifest,
and the three files it serves were too), and it reported `tools-office.ts`/`tools-read.ts` **stale**,
which is the fix seen from the other side. `tools-write.ts` stays with a line saying why not to
re-delete it: its code has no `fetch(` either, but that walk does not strip comments (NIT-8) and the
file says *"// re-fetch (never re-sends)"*.

The guard-corpus census refused my L6-2 pin's own hand-rolled walk of the step packages — exactly
the second copy that audit exists to prevent — so the writer census derives its corpus from
`engine-sources.ts`, with a non-vacuity clause that the shared corpus really contains the step the
writer lives in.

## A7 — verification

| | |
|---|---|
| census suite | **24/24** · the L6-2 pin **3/3** · closure + guard-corpus + census together **108/108** |
| full server suite | **491 files, 7,375 clauses, exit 0** on a quiet box (a first run showed 3 load flakes — a temp-home `ENOENT`, an OpenAI-seam timing clause and a souls-installer file load; all three green in isolation and absent from the clean run) |
| `npm run typecheck` | clean |
| `npm run gates` | **14 of 15 blocking green.** One refusal, below |
| mutants this round | **9**, all RED with a message naming the defect, all reverted with sha256 re-asserted |

⚠ **THE ONE ASK, and it is the only thing between this branch and a green gate run:**

```
packages/server/src/memory/embeddings.ts   growth baseline 251 → 319   (+68, +27.1%)
```

Measured rather than assumed: the ceiling is 251 × 1.25 = **313.75**, and the file was at **313** at
`e83674d6` — green with three quarters of a line to spare, confirmed by running the detector at that
commit. Another lane's growth had spent the headroom; **L2-3's six lines are what cross it, so the
crossing is mine.** The six are one import, two comment lines naming the seven awaiting paths, one
slot, `try {`, and a one-line `finally`. Either a baseline re-record (251 → 319) or a `ratchets.json`
pin at 319 closes it; a pin is the tighter instrument since it makes the file decrease-only from
there. I did not take either.

Refused alternative, on principle rather than on line count: moving the slot to a new
`memory/embed-stop.ts` reaches net-zero in `embeddings.ts`, but it takes `openAgentCall` **out of the
file that owns the dial**, so the census would need a "rides the door" exemption for it — the exact
shape of sentence this round exists to delete.
