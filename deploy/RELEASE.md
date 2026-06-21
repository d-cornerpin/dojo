# Releasing the DOJO platform

**Cut a release with one command. Do not do it by hand.**

```bash
bash deploy/release.sh <version>          # e.g. bash deploy/release.sh 3.0.4
# or: npm run release -- 3.0.4
```

That script does the whole thing and **refuses to report success unless the
release is actually complete**: preconditions → typecheck → bump → build →
verify the version embedded in the zip → commit → tag → push → create the
GitHub release **with both assets** → verify the published release.

### Why this script exists

Every release that has gone wrong went wrong the same way: the version was
bumped, committed, tagged, pushed, and a GitHub release page was created — but
the `.zip`/`.pkg` were **never uploaded**. The release looked done. It wasn't.
With no `dojo-platform.zip` on the release, every user's DOJO sees the new
version via `releases/latest`, tries to self-update, and fails to download it.

The self-updater (`packages/server/src/gateway/routes/update.ts`) pulls
`dojo-platform.zip` from the **latest** GitHub release. The two non-negotiables
for a working release are therefore:

1. `releases/latest` resolves to the new tag, and
2. that release carries `dojo-platform.zip` (the self-update payload) and
   `Agent-DOJO-Installer.pkg` (the fresh-install installer).

### Dry run it first

```bash
bash deploy/release.sh 3.0.4 --dry-run
```

Runs every local step (bump, build, verify the embedded version) then reverts
the bump without committing/pushing/releasing. Proves the release will go clean.

### Custom release notes (optional)

By default the notes are the commit subjects since the previous tag. To curate:

```bash
bash deploy/release.sh 3.0.4 --notes-file /tmp/notes.md
```

You can also edit the notes on the GitHub release page afterward — that does not
affect the assets or the self-update.

## Verify any release (and repair a broken one)

Read-only check that a release is complete and the self-update will work:

```bash
bash deploy/verify-release.sh            # checks the current root package.json version
bash deploy/verify-release.sh 3.0.3      # checks a specific version
# or: npm run release:verify -- 3.0.3
```

It checks all four things that have to be true: the release exists, both assets
are uploaded, `releases/latest` points at this tag, and the zip is actually
downloadable. **Run it after any release — including one done by hand.**

If it reports a release is incomplete (the 3.0.3 situation), repair without
re-bumping or re-tagging — just build and attach the missing assets:

```bash
npm run build:package
gh release upload v<version> \
  deploy/dist/dojo-platform.zip deploy/dist/Agent-DOJO-Installer.pkg \
  --repo d-cornerpin/dojo --clobber
bash deploy/verify-release.sh <version>   # confirm it's green now
```

## If you ever must do it manually

Don't, but if the script is unavailable, the asset upload is the step that gets
skipped, so: build (`npm run build:package`), confirm the zip embeds the right
version (`unzip -p deploy/dist/dojo-platform.zip dojo-platform/platform/package.json`),
commit + tag + push, then `gh release create <tag> deploy/dist/dojo-platform.zip
deploy/dist/Agent-DOJO-Installer.pkg ...`, and **finish with
`bash deploy/verify-release.sh <version>`**. If that exits non-zero, the release
is not done.
