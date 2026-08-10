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

`release` verifies the workspace, checks the package tarball, and runs
`changeset publish`. Publishing requires npm authentication and must be done
from the intended release branch.
