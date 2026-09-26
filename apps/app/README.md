# Planview app

The authenticated product surface is a SolidStart 2 application. Better Auth
and Convex own authentication and document metadata, while UploadThing owns
the bytes for standalone `.html` files.

## Local development

From the repository root:

```sh
npm install
npm run dev --workspace @planview/app
```

The app reads the Convex variables generated in `apps/app/.env.local`. To use
the shared cloud development deployment, select it first and generate the
Convex bindings:

```sh
cd apps/app
npx convex deployment select <team>:<project>:dev/<name>
npx convex dev --once
```

The Convex CLI writes `VITE_CONVEX_URL` and `VITE_CONVEX_SITE_URL`; the server
routes accept those names locally and `CONVEX_URL`/`CONVEX_SITE_URL` on Railway.

## UploadThing setup

Create an UploadThing app, leave file access on the public testing tier, then
copy the app's server token into `apps/app/.env.local`:

1. Create an app at [uploadthing.com](https://uploadthing.com/).
2. Open the app's API key/settings view and copy the complete token value.
3. Add it locally as `UPLOADTHING_TOKEN`:

```text
UPLOADTHING_TOKEN=<token-from-uploadthing>
```

Do not use a `VITE_` prefix. This token is only read by servers. The same
value must be set on the Railway app service and its Convex deployment:
Convex uses it to delete UploadThing files in the background. Deploy the
Convex variable before enabling this deletion flow.

The server upload endpoint is limited to one standalone HTML file up to 8 MB.
The testing tier uses public-read objects, so anyone who
obtains an UploadThing object URL may fetch it. The plansplease preview route
still requires the signed-in workspace session. A future provider such as S3
or R2 can implement the storage adapter in `src/lib/document-storage.ts`;
Convex stores the provider name and logical storage locator, not
provider-specific bytes. New UploadThing records use an owner-bound custom
identifier as that locator, while older records using raw UploadThing file
keys remain supported during the transition.

## Authentication setup

Better Auth runs inside Convex. It is not a hosted auth account. The GitHub
OAuth client ID and secret must be set as Convex deployment variables before
the sign-in button can complete:

```sh
npx convex env set BETTER_AUTH_SECRET
npx convex env set SITE_URL http://localhost:3000
npx convex env set GITHUB_CLIENT_ID <github-client-id>
npx convex env set GITHUB_CLIENT_SECRET
```

Do not commit `.env.local`, `.env.staging`, or OAuth secrets. The staging
deployment uses the same functions and has its own values for these variables.

Generate a random `DOCUMENT_MUTATION_SECRET` of at least 32 bytes and set the
same value in the app server environment and its Convex deployment. It signs
short-lived proofs for metadata creation. Uploads
will fail closed until both sides have this value.

## Hosted MCP

The cloud agent endpoint is `${SITE_URL}/mcp`. It uses Better Auth 1.7 OAuth
with Client ID Metadata Documents (CIMD), account sign-in, explicit consent,
and a `cloud:documents` scope. Agents can list, read, upload, and delete only
the signed-in account's cloud documents. `read_document` returns at most 32,768
characters per call; repeat with `nextOffset` to read the rest. Uploads accept
one HTML document up to 8 MiB. There is no document count quota during
development. Deletes hide the document and queue storage cleanup; the existing
Convex retry worker finishes cleanup in the background. UploadThing files have
public URLs during development, including files uploaded through MCP.

The app and Convex deployment both need the same public `SITE_URL` and a
random `CIMD_FETCH_SECRET` of at least 32 bytes. The Convex HTTP runtime sends
CIMD metadata requests to the app's private
`/api/internal/cimd-fetch` endpoint; the Node transport validates DNS and pins
the connection to a public address. Set `CONVEX_SITE_URL` on the app so it can
proxy OAuth endpoints and authorization server metadata. Configure
`DOCUMENT_MUTATION_SECRET` and `UPLOADTHING_TOKEN` on both app and Convex as
described above. Set these variables on the Convex deployment before deploying
the app, then deploy the app with the same `SITE_URL`.

The current Convex Better Auth adapter is still published against Better Auth
1.6 and imports a provider removed in 1.7. The repository's postinstall and
build hooks remove that obsolete adapter hook from the installed package; the
new OAuth provider owns the agent flow. The auth component is installed locally
under its original `betterAuth` name, with a schema that retains the existing
tables and adds the 1.7 OAuth tables. Review an adapter upgrade before removing
the compatibility hook. To regenerate its schema, run
`node scripts/prepare-auth-adapter.mjs` from the repository root, then from
`apps/app` run:

```sh
npx auth@latest generate --config ./convex/betterAuth/auth.ts --output ./convex/betterAuth/generatedSchema.ts --yes
```

The generated file should retain its repository header. OAuth account sign-in
requires the existing GitHub provider configuration. Point an MCP client at
`${SITE_URL}/mcp`; it discovers the protected resource and authorization server
through `/.well-known/` metadata, then requests consent in the browser.

## Deployment contract

Railway deploys from the repository root. The service should use:

```text
Build: npm run build --workspace @planview/app
Start: npm start --workspace @planview/app
Health check: /api/health
```

The current staging service is configured with that contract. It needs
`CONVEX_URL`, `CONVEX_SITE_URL`, `UPLOADTHING_TOKEN`, `DOCUMENT_MUTATION_SECRET`,
`CIMD_FETCH_SECRET`, and `SITE_URL` before OAuth and cloud uploads can be tested.

## Current API surface

- `/api/auth/*` proxies Better Auth to the Convex site.
- `/mcp` is the OAuth protected hosted agent endpoint. The OAuth metadata
  lives at `/.well-known/oauth-protected-resource/mcp` and
  `/.well-known/oauth-authorization-server/api/auth`.
- `GET /api/documents` lists the signed-in user's documents.
- `GET /api/documents?limit=50` returns a page with `page`, `isDone`, and
  `continueCursor`. Pass `cursor=<continueCursor>` to read the next page. The
  limit must be between 1 and 100. Requests without pagination parameters
  retain the original array response for existing clients.
- `POST /api/documents/upload` uploads an HTML file and records its metadata
  in one server request. It accepts either a web session or a CLI upload-only
  credential; CLI credentials cannot list, view, or delete documents.
- `POST /api/cli/session` issues a revocable upload-only credential after the
  signed-in user approves the local CLI in the browser.
- `DELETE /api/cli/session` revokes the presented CLI credential.
- `GET /api/documents/:id` views a workspace document.
- `DELETE /api/documents/:id` returns `202 Accepted` for UploadThing documents
  after marking them hidden. A Convex worker deletes the file and metadata in
  the background. Failed attempts use exponential backoff, and a one-minute
  reconciliation job recovers interrupted workers. Legacy Convex-stored
  documents are deleted in the mutation and return `204 No Content`.
- `/api/health` is the Railway health check.

Document previews are authorized through the user's Convex session and served
inline with a sandboxed, opaque origin. This lets agent-generated HTML run its
own scripts without giving it access to the app session or same-origin
application APIs. Existing Convex-backed records remain readable while the
new provider boundary is rolled out. Bundles and private storage are later
slices.
