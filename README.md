# Planview

Planview is a TypeScript ESM monorepo for previewing HTML locally and saving standalone pages in a
account-based alpha cloud workspace. Cloud file URLs are public during testing.

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

## Marketing site

Build or smoke-test the private Astro site with:

```sh
npm run build --workspace @planview/site
npm test --workspace @planview/site
```

`BASE_PATH` sets an optional deployment prefix. Leading and trailing slashes are
normalized, for example `BASE_PATH=/plansplease npm run build --workspace
@planview/site`. It is normally unset because the site is deployed at the root of
its Railway domain.

The marketing site is currently branded as plansplease and runs in the staging environment on
Railway. It is available at
[`plansplease-site-staging.up.railway.app`](https://plansplease-site-staging.up.railway.app)
in the `planview-cloud` project. The staging app is available at
[`app-staging-a39a.up.railway.app`](https://app-staging-a39a.up.railway.app).
There is no production marketing service or custom domain yet.

The marketing staging service uses this configuration:

- build: `npm run build --workspace @planview/site`
- start: `npm start --workspace @planview/site`
- health check: `/health`

The cloud app will get a production domain after the product domain is purchased and configured.

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

Railway builds the site from the monorepo root so it can use the repository
lockfile. The marketing services do not share a runtime with the SolidStart app.
`server.mjs` serves the generated Astro output and exposes the health endpoint.
Vercel is not used for the marketing site.

## Security follow-up

`npm audit` on the checked-in lockfile reports 8 vulnerable package names
(1 low, 6 high, and 1 critical), affecting 9 installed lockfile nodes. The names
are `astro@5.18.1`, `esbuild@0.27.7`, `sharp@0.34.5`, `unstorage@1.17.5`,
`uploadthing@7.7.4`, `@uploadthing/solid@7.3.3`, `@uploadthing/shared@7.1.10`,
and `effect@3.17.7`. Effect appears in two nodes, nested under `@uploadthing/shared`
and `uploadthing`. npm's severity totals count vulnerable package names; one
name can have multiple affected lockfile nodes and several advisory records.

Astro is a development dependency used to build the static `apps/site`; it does
not run in the SolidStart app's runtime. Its findings include
[XSS](https://github.com/advisories/GHSA-j687-52p2-xcff),
[SSRF](https://github.com/advisories/GHSA-2pvr-wf23-7pc7),
[base-path authorization](https://github.com/advisories/GHSA-376h-93r7-7g6f),
the critical [AVIF optimization RCE](https://github.com/advisories/GHSA-26w7-cxv4-gfx2),
an [esbuild Windows dev-server file-read issue](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr),
and transitive [sharp/libvips](https://github.com/advisories/GHSA-f88m-g3jw-g9cj)
and [sharp/libheif](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c) findings.
The AVIF RCE applies when an attacker can cause Astro to process an untrusted
AVIF image. The current site source has no AVIF assets or Astro image-processing
calls, and app uploads do not flow into the site build. The audit entry alone
does not establish that an attacker can supply input to Astro's optimizer. For
this lockfile, npm reports `astro@7.3.4` as the aggregate fix; the AVIF advisory
itself lists `7.2.8` as patched.

The app uses UploadThing's upload route, client helpers, and `UTApi`. Its
dependency tree contains Effect `3.17.7`, separate from the repository's Effect
v4 dependency. The [Effect advisory](https://github.com/advisories/GHSA-38f7-945m-qr2g)
describes `AsyncLocalStorage` context loss or contamination in Effect fibers
under concurrent load when RPC is involved. The lockfile confirms the affected
version is present, but does not show that this app exercises that RPC path.
The audit's suggested fixes are `astro@7.3.4`, `uploadthing@6.12.0`, and
`@uploadthing/solid@6.5.0`, each a major-version change from the lockfile. No
broad override or major upgrade has been applied pending compatibility review.

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
