# Planview

Planview is a TypeScript ESM monorepo for turning an HTML file or page folder into a retained,
immutable localhost URL.

## Bootstrap status

The foundation includes the public `@abijith-suresh/planview` npm workspace and the
private `@planview/core`, `@planview/daemon`, `@planview/storage`, and
`@planview/local` workspaces. The CLI
is an installable TypeScript ESM package with detached daemon lifecycle
commands: `start`, `status`, `stop`, and `restart`, plus `publish <file|folder>`
and `get <id|url>` for immutable HTML snapshots. `publish --open <file|folder>`
opens the resulting URL after publishing. A publish folder must contain
`index.html`; its assets are served below the same immutable URL. The private daemon is bundled into
the one published CLI artifact and owns loopback-only lifecycle HTTP and direct
snapshot serving.
See [apps/cli/README.md](apps/cli/README.md) for CLI usage and automation details.
Core resolves conventional per-user application-data paths and holds the fixed
v1 policy values. Storage owns daemon-private metadata in a versioned SQLite
database, immutable document-file staging/finalization, and a private
publication coordinator. It does not publish URLs, run cleanup policy, or
expose document/HTTP behavior. The private `apps/site` workspace is a static
project site, kept separate from the local daemon and application UI.

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
foundation smoke test, the CLI's built-in tests, storage's hermetic SQLite
integration tests, and workspace builds. The CLI package can also be checked
directly:

```sh
npm run typecheck --workspace @abijith-suresh/planview
npm test --workspace @abijith-suresh/planview
npm pack --dry-run --workspace @abijith-suresh/planview
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

`BASE_PATH` sets an optional deployment prefix (leading and trailing slashes are
normalized), for example `BASE_PATH=/planview npm run build --workspace
@planview/site`. It is normally unset because the marketing site is deployed at
the root of its Vercel domain.

## Vercel deployment

CI runs the required Node 24 quality gate on Linux for pull requests and pushes to
`main`. It also packs the public `@abijith-suresh/planview` npm package and
smoke-tests the resulting tarball without publishing it or requiring a secret.
macOS and Windows run the same clean packed artifact through CLI install,
publish/get, daemon status/stop, and bundled skills installation; the POSIX-only
storage suite remains part of Linux `npm run verify`. A push to `main` validates the
repository, then the Changesets Action creates or updates the generated
`changeset-release/main` version PR with the `RELEASE_TOKEN` PAT. Merging that PR
runs the same release command. npm publishing is disabled by default. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the release policy.

The marketing site is a static Astro project deployed by Vercel. Its Vercel
project should use `apps/site` as the Root Directory, detect Astro as the
framework, and use Node 24. Vercel's Git integration provides a preview
deployment for each branch or pull request and promotes the `main` deployment
to production. No repository deployment secret is required.

## Security follow-up

`npm audit` currently reports XSS/SSRF advisories for the pinned
`astro@5.18.1`, an arbitrary-file-read issue in its `esbuild@0.27.7`
Windows development server, and inherited libvips issues in transitive `sharp`.
npm's available fix is `astro@7.2.0`, a major upgrade from Astro 5, so this
slice does not apply it without a compatibility review. These findings remain a
build-toolchain follow-up; no audit suppression is used.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for changeset, verification, and release
policy requirements.

## Planned structure

- `apps/cli` — public npm package (`@abijith-suresh/planview`), with the `planview` command
- `apps/site` — private static project site
- `packages/core` — private path, v1 policy, document identifier, and source-file validation primitives
- `packages/daemon` — private detached lifecycle daemon and authenticated management boundary
- `packages/storage` — private daemon-owned metadata and document-file storage boundary
- `packages/local` — reusable local application API used by the CLI and future MCP adapter
- `packages/*` — reusable implementation packages

SQLite-backed publication and CLI retrieval are implemented. The daemon performs
startup reconciliation and authenticated 30-day last-access cleanup at startup and
every 24 hours; `planview clean` invokes the same policy.
