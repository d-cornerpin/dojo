# DOJO Releases & Update Channels — the canonical process

**Every agent that touches this repo must follow this file for commits and releases.**
It is the single source of truth. If a step here conflicts with your assumptions, this file wins.

---

## 0. The HARD RULES (read first)

1. **Never commit, push, or release without explicit user approval.** "Looks good" is not approval. Wait for "ship it" / "commit it" / "release it" or equivalent.
2. **Always confirm the channel before any commit/push/release.** When the user says "commit" / "push" / "ship" / "release," and they did **not** say which channel, ask:
   > "Stable (main) or Preflight?"
   Never assume. Stable goes to every user's box; Preflight goes only to boxes opted into the Preflight channel.
3. **Releases are cut only with `deploy/release.sh`** (never by hand), and it always ends by running `deploy/verify-release.sh`. The recurring historical failure is a release whose assets never uploaded — the script guards against it; don't bypass it.

---

## 1. Two channels, two branches

| Channel | Branch | Who gets it | Release tag |
|---|---|---|---|
| **Stable** | `main` | every user | `vX.Y.Z` |
| **Preflight** | `Preflight` | only boxes with the Settings → Update toggle set to Preflight | `vX.Y.Z-preflight.N` (GitHub **pre-release**) |

Why it works: GitHub's `releases/latest` (what the Stable updater reads) **excludes pre-releases**, so Preflight builds are invisible to Stable users. The Preflight channel reads the full releases list and takes the newest by version.

**Always know where you are first:** `git branch --show-current`.

### How version numbers work (read this — it's the #1 thing agents get wrong)

Stable and Preflight are **two independent counters.** Promoting a feature does NOT copy the Preflight number onto Stable.

**THE RULE: a Preflight build is always numbered `current-stable + 1 patch`, plus a build ordinal.** Read `3.1.7-preflight.2` as *"the 2nd test build aiming at the next stable, 3.1.7."*

- Stable climbs **one feature at a time** as the user blesses things: `3.1.6 → 3.1.7 → 3.1.8…`
- A Preflight build must always rank **above** current stable. If it equals or trails stable, the Preflight box treats stable as newer, installs that, and **silently drops the test feature** — so `3.1.6-preflight.x` while stable is `3.1.6` is WRONG; it must be `3.1.7-preflight.x`.
- The `-preflight.N` ordinal only climbs when you cut **multiple test builds aiming at the same stable target** without promoting. Each promotion bumps stable by one and the next Preflight build resets to `<new-stable+1>-preflight.1`.

Worked example (stable starts at 3.1.6):

| Action | Stable | Preflight |
|---|---|---|
| put a feature in Preflight | 3.1.6 | **3.1.7**-preflight.1 |
| iterate twice more | 3.1.6 | 3.1.7-preflight.2, .3 |
| promote that feature | **3.1.7** | (resync) |
| put the NEXT feature in Preflight | 3.1.7 | **3.1.8**-preflight.1 |

**You don't compute this by hand.** `deploy/release.sh --preflight` (no base arg) reads the latest stable, goes one patch above, and auto-increments `.N`. Only pass an explicit base to target a bigger jump (e.g. `--preflight 3.2.0`).

---

## 2. Commit convention (makes per-feature promotion reliable)

Every commit made **on the `Preflight` branch** must include a trailer naming its feature:

```
Preflight-Feature: <slug>
```

Use one stable slug per feature (e.g. `migration-overhaul`, `voice-tuning`). This is how any later agent finds exactly which commits belong to a feature when promoting it:

```bash
git log Preflight --grep "Preflight-Feature: <slug>" --format='%H %s'
```

End every commit message with the standard trailers:
```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

---

## 3. Procedures

### A — Cut a Preflight build (test a feature on a real box)
```bash
git checkout Preflight          # create from main if it doesn't exist: git checkout -b Preflight main
# ...make changes...
git add -A
git commit -m "feat(x): …" -m "Preflight-Feature: <slug>" -m "Co-Authored-By: …"
bash deploy/release.sh --preflight             # auto-numbers: latest stable + 1 patch, next .N
```
`release.sh --preflight` picks the number for you (latest stable + 1 patch, auto-incrementing `.N`), builds, publishes a GitHub **pre-release**, and verifies. The user flips Settings → Update → **Preflight** on their box and installs it.

### B — Cut a Stable release (small fix that skips Preflight)
```bash
git checkout main
# ...make changes...
git add -A && git commit -m "fix(x): …" -m "Co-Authored-By: …"
bash deploy/release.sh <X.Y.Z>                # stable; pushed to main, all users get it
```

### C — Promote a proven Preflight feature to Stable (cherry-pick)
This is **what happens when the user is confident in a Preflight feature and wants it on main.**
```bash
git log Preflight --grep "Preflight-Feature: <slug>" --format='%H %s'   # find the commits (oldest→newest)
git checkout main
git cherry-pick <sha1> <sha2> …               # in chronological order
bash deploy/release.sh <X.Y.Z>                # stable release with the promoted feature
```
Then **resync Preflight** (Procedure D) so the cherry-picked change isn't re-applied later.

### D — Resync Preflight after any Stable release
```bash
git checkout Preflight
git merge main                                # resolve any already-applied cherry-pick conflicts in favor of the existing change
git push origin Preflight
```
The next Preflight build's base is now `new-stable + 1 patch` (the invariant in §1).

---

## 4. Reference

- **Dev installs can't self-update.** `applyUpdate` only runs against a production install (`~/.dojo/platform`). On the dev server, test the toggle (it persists + re-checks); actual installs happen on a real box.
- **Dry run anything risky:** `bash deploy/release.sh <ver> [--preflight] --dry-run` builds + verifies the embedded version, then reverts — no commit/push/release.
- **Every release ships notes.** `release.sh` always writes them (a `Changes since <prev-tag>:` commit list, or `--notes-file` if you pass one), and `verify-release.sh` now **fails the release if the body is empty or only a GitHub auto "Full Changelog" link.** If you ever finish a release by hand, you MUST add notes: `gh release edit <tag> --repo d-cornerpin/dojo --notes-file <file>`. Never use a bare `--generate-notes` as the only source — for direct-to-branch commits it produces just a changelog link, which counts as "no notes."
- **If a release fails verification,** it printed the exact `gh release upload … --clobber` repair command; run it, then re-run `verify-release.sh`.
- The channel toggle + updater live in `packages/server/src/gateway/routes/update.ts` (`getUpdateChannel` / `resolveLatestRelease` / `compareVersions`) and Settings → Update (`UpdateTab`).
