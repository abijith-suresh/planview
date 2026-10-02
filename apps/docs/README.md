# plansplease documentation

An independent static Astro + Starlight application. It has no Convex connection,
UploadThing token, account session, or imports from another application workspace.
Fonts, documentation search, and page assets are served locally with the build.

## Develop and verify

From the repository root, using the declared Node and npm versions:

```sh
npm ci
npm run dev --workspace @planview/docs
npm run typecheck --workspace @planview/docs
npm test --workspace @planview/docs
npm run build --workspace @planview/docs
npm start --workspace @planview/docs
```

The tests build both root and prefixed sites, check generated links and search
artifacts, and exercise production HTTP health, redirects, MIME types, cache
headers, malformed paths, and symlink containment. The full repository review
checks in `CONTRIBUTING.md` still apply.

## Public URLs and deployment

Copy `.env.example` to `.env.local` for development. These are public **build-time**
settings. Rebuild when changing them:

| Setting | Default |
| --- | --- |
| `PUBLIC_DOCS_URL` | `https://plansplease-docs-staging.up.railway.app` |
| `PUBLIC_APP_URL` | `https://plansplease-app-staging.up.railway.app` |
| `PUBLIC_SITE_URL` | `https://plansplease-site-staging.up.railway.app` |

`PUBLIC_DOCS_URL` may include a prefix such as `https://example.com/manual/`.
Astro generates canonical URLs and all navigation/search/assets under that prefix.
The server reads the built base path from an internal runtime manifest rather
than guessing it from incoming Host headers. It does not serve that manifest.
HTTP origins are allowed only for localhost development; the app URL is an origin.

The intended future custom domain is `docs.plansplease.com`; it is not owned or
configured yet. The Railway staging service is separate from app and marketing:

- Build: `npm run build --workspace @planview/docs`
- Start: `npm start --workspace @planview/docs`
- Health check: `/health`
- Runtime port: Railway's `PORT` value, default `4322` locally

The Node server exposes GET/HEAD only, validates paths before serving files,
checks real paths remain under `dist`, and serves search WASM with the required
MIME type. HTML and search files revalidate; hashed Astro assets are immutable.
It should run against a trusted, immutable repository build, not a directory
containing user uploads. Docs deployments do not require cloud-app secrets.

## Content maintenance

Guides describe `main`, with a dated deployment-status note for staging. Keep
working MCP tools and CLI commands checked against their source. Mark open
implementations and proposals separately; do not advertise private storage,
unlimited paid plans, npm publication, or supported self-hosting before those
contracts exist. The current folder-root CLI retrieval limitation is documented.

Canonical entry routes are `/getting-started/`, `/guides/mcp/`, and `/guides/cli/`.
Marketing `/docs/`, `/cli/`, and `/mcp/` keep their legacy pages and link to these
canonical docs routes using their own `PUBLIC_DOCS_URL` build setting.

This app pins Starlight 0.42.5 and Astro 7.3.5. Starlight's published peer metadata
supports Astro `^7.2.10`; the installed pair builds with the repository's Node 24
and npm 11 versions. Setup follows the official [Starlight manual setup](https://starlight.astro.build/manual-setup/),
[search guide](https://starlight.astro.build/guides/site-search/), and
[Astro site/base configuration](https://docs.astro.build/en/reference/configuration-reference/#base).
