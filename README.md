# Planview

Planview is a TypeScript ESM monorepo for turning an HTML file into a persistent,
immutable localhost URL.

## Bootstrap status

Milestone 0 includes the repository foundation and the public `planview` CLI
workspace. The CLI is an installable TypeScript ESM package with deterministic
help and version output; application subcommands are intentionally deferred to
later milestones. The private `apps/site` workspace is a static project site,
kept separate from the local daemon and application UI.

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

## Site builds

Build or smoke-test the private Astro site with:

```sh
npm run build --workspace @planview/site
npm test --workspace @planview/site
```

`BASE_PATH` sets the deployment prefix (leading and trailing slashes are
normalized), for example `BASE_PATH=/planview npm run build --workspace
@planview/site`. When `BASE_PATH` is unset, `GITHUB_REPOSITORY=owner/name`
derives `/name`; an explicit `BASE_PATH` always wins. The default is the root
site with no prefix.

## Security follow-up

`npm audit` currently reports XSS/SSRF advisories for the pinned
`astro@5.18.1`, an arbitrary-file-read issue in its `esbuild@0.27.7`
Windows development server, and inherited libvips issues in transitive `sharp`.
npm's available fix is `astro@7.2.0`, a major upgrade from Astro 5, so this
slice does not apply it without a compatibility review. These findings remain a
build-toolchain follow-up; no audit suppression is used.

## Contributing and releases

See [CONTRIBUTING.md](CONTRIBUTING.md) for changeset and verification requirements
and [RELEASING.md](RELEASING.md) for the maintainer release procedure.

## Planned structure

- `apps/cli` — public command-line package (`planview`)
- `apps/site` — private static project site
- `packages/*` — reusable implementation packages

Reusable packages, the application runtime, and persistence layers will be
introduced in later milestones.
