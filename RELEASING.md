# Releasing

The public npm package is `planview`, built from `apps/cli`. Releases use
Changesets and remain patch-only before `1.0.0`.

1. Confirm the pending changesets with `npm run changeset:status`.
2. Run `npm run verify` and `npm run pack:check`. Verification includes the
   release-policy check, which rejects pre-1.0.0 minor or major `planview`
   changesets while allowing patch changesets and unrelated/private entries.
3. Run `npm run version-packages` to apply the release plan and update
   changelogs. This command runs the release-policy check again before
   changing versions. Review the generated changes before committing them.
4. Commit the version and changelog updates, then run `npm run release`. The
   release command repeats the policy check before verification, packing, and
   publishing.

`release` verifies the workspace, checks the package tarball, creates a verified
prebuilt tarball, and publishes that tarball with lifecycle scripts disabled.
Publishing requires npm authentication and must be done from the intended
release branch.

## GitHub Actions release

`.github/workflows/release.yml` runs on pushes to `main` (including merged pull
requests). It installs with `npm ci --ignore-scripts`, runs `npm run verify`, checks the
public package with `npm run pack:check`, and creates a prebuilt tarball with
`npm run pack:verified` before publishing. The final publish uses
`npm publish --ignore-scripts`, so neither `RELEASE_TOKEN` nor
`NODE_AUTH_TOKEN` is exposed to package lifecycle scripts. The repository's
only non-private workspace is `planview`; the private workspaces remain
excluded by `.changeset/config.json`.

Set the repository secret `RELEASE_TOKEN` to an npm automation token. The token
is provided only to the final publish step. Manual runs default to `dry_run`,
which performs the same immutable install, verification, and pack checks but
never publishes to npm or uses the release token. A manual publish must
explicitly set `dry_run` to `false` and use the `main` ref.

The workflow does not version pending Changesets in place. Maintainers should
run `npm run version-packages`, review and merge the generated version and
changelog changes, then let the push to `main` publish that release.
