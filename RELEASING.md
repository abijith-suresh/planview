# Releasing

The public npm package is `@abijith-suresh/planview`, built from `apps/cli`. Its
CLI binary remains `planview`. Releases use Changesets and remain patch-only
before `1.0.0`.

1. Confirm the pending changesets with `npm run changeset:status`.
2. Run `npm run verify` and `npm run pack:check`. CI additionally installs the
   clean packed artifact on macOS and Windows and exercises CLI lifecycle,
   publish/get, and skills installation there; those jobs do not publish or
   require deployment credentials. Verification includes the release-policy
   check, which rejects pre-1.0.0 minor or major
   `@abijith-suresh/planview` Changesets while allowing patch Changesets and
   unrelated/private entries.
3. Run `npm run version-packages` to apply the release plan, update
   changelogs, and refresh `package-lock.json` without running lifecycle scripts.
   This command runs the release-policy check again before changing versions.
   Review the generated changes before committing them.
4. The Changesets Action commits the generated version and changelog updates to
   `changeset-release/main` and opens or updates the release PR. Review that PR;
   its normal CI runs before merging. The merge push runs the same verified
   release command and is the only automated publish trigger.

`release` verifies the workspace, checks the package tarball, creates a verified
prebuilt tarball, and invokes the guarded publisher with lifecycle scripts
disabled. Publishing is explicitly disabled by default; enabling it requires an
explicit registry, `NPM_TOKEN` or `NODE_AUTH_TOKEN`, and
`PLANVIEW_NPM_PUBLISH=enabled`.

## GitHub Actions release

`.github/workflows/release.yml` runs on pushes to `main`. It installs with
`npm ci --ignore-scripts`, validates and packs the public package, then invokes
`changesets/action` with the `RELEASE_TOKEN` PAT. Pending Changesets create or
update `changeset-release/main`; after that PR is reviewed and merged, the next
`main` push runs the guarded verified publisher for the versioned package.

Set `RELEASE_TOKEN` to a GitHub PAT with permission to push the generated branch
and create/update pull requests; the PAT is not an npm credential. Publishing is
currently safe by default: `PLANVIEW_NPM_PUBLISH=disabled` performs no npm
publish. To enable the merge-triggered publish later, configure the repository
variable `PLANVIEW_NPM_PUBLISH=enabled`, `PLANVIEW_NPM_REGISTRY` explicitly, and
a separate `NPM_TOKEN` secret; keep `PLANVIEW_NPM_REGISTRY` at the workflow's
secure npmjs default (or update the setup-node registry configuration together
with any deliberate registry change). `setup-node` configures the scoped
`@abijith-suresh` npm registry without writing the token; `NODE_AUTH_TOKEN` is
provided only to the final publish-capable Changesets step. The final publisher
uses a verified tarball and `npm publish --ignore-scripts`; release verification
runs without GitHub or npm credentials, and the publish child cannot run package
lifecycle scripts.

The repository's only releasable workspace is
`@abijith-suresh/planview`; the private workspaces remain excluded by
`.changeset/config.json`. Feature PRs that change releasable CLI source paths
must add a patch Changeset. The generated release PR is exempt because it
contains the version and changelog produced by Changesets.
