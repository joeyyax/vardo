# Releasing

The git tag is the source of truth for the version. Never edit `version` in `package.json` by hand; `pnpm release` does it.

## Cut a release

```bash
pnpm release minor            # dry run
pnpm release minor --publish  # do it
```

The argument is `patch`, `minor`, `major` or an explicit `X.Y.Z[-rc.N]`. An explicit version overrides the computed one.

## Dry run

Without `--publish` the script prints the next version, the changelog section, every command it would run and anything that would block a publish. It changes nothing on disk or remotely, and does not fetch.

## What `--publish` does

1. Fetches `origin` and refuses unless the working tree is clean, the branch is `main`, `main` matches `origin/main`, the version is valid and strictly greater than the latest `vX.Y.Z` tag, and `gh` is signed in.
2. Reads commits since the last tag and groups them: Features (`feat`), Fixes (`fix`), Performance (`perf`), Other (`docs`, `refactor`, `build`, `ci`, and subjects that don't parse). `chore`, `test`, `style`, merges and reverts are dropped unless marked breaking.
3. Prepends the section to `CHANGELOG.md` under `## [Unreleased]` and sets `package.json` `version`.
4. Commits `chore(release): vX.Y.Z` and creates the annotated tag `vX.Y.Z`.
5. Runs `git push origin main vX.Y.Z`, then `gh release create` with only this version's section as the notes.

If a step fails, the script prints the state of the repo and the commands to resume or undo.

## Bump rules

- `!` after the type or a `BREAKING CHANGE:` footer marks a commit as breaking.
- Under 0.x, `major` bumps minor. Pass `1.0.0` to go stable.
- A `patch` bump with breaking changes since the last tag prints a warning.
- No tags yet: the base is the `package.json` version, every commit counts and the section says "Initial release."

## Release candidates

`pnpm release 1.0.0-rc.1 --publish` tags `v1.0.0-rc.1` and creates the GitHub release with `--prerelease`. GitHub's "latest release" ignores pre-releases.

The changelog for a stable release covers everything since the last stable tag, so `1.0.0` includes the changes shipped in its release candidates. Release candidate sections stay in `CHANGELOG.md`.

## Limitation

The script pushes `main` directly. If branch protection requires pull requests, the push fails and the script must change to open a release PR instead.
