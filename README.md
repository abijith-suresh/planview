# Planview

Planview is a TypeScript ESM monorepo for turning an HTML file into a persistent,
immutable localhost URL.

## Bootstrap status

Milestone 0 includes the repository foundation and the public `planview` CLI
workspace. The CLI is an installable TypeScript ESM package with deterministic
help and version output; application subcommands are intentionally deferred to
later milestones.

## Prerequisites

Use Node.js 24.19.0 and npm 11.16.0 (the versions declared by the repository
configuration). Install the locked dependencies with:

```sh
npm ci
```

Run the complete foundation check with:

```sh
npm run verify
```

The root verification runs formatting, linting, workspace typechecks, the
foundation smoke test, the CLI's built-in tests, and workspace builds. The CLI
package can also be checked directly:

```sh
npm run typecheck --workspace planview
npm test --workspace planview
npm pack --dry-run --workspace planview
```

The package dry run invokes the CLI's `prepack` build, so it does not depend on
an existing ignored `dist` directory. Workspace checks and builds run each
package's matching script when present.

## Contributing and releases

See [CONTRIBUTING.md](CONTRIBUTING.md) for changeset and verification requirements
and [RELEASING.md](RELEASING.md) for the maintainer release procedure.

## Planned structure

- `apps/cli` — public command-line package (`planview`)
- `apps/site` — documentation and project site
- `packages/*` — reusable implementation packages

Those workspaces, along with the application runtime and persistence layers, will
be introduced in later milestones.
