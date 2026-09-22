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

Do not use a `VITE_` prefix. This token is only read by the server. The same
value will later be added to the Railway staging service; it is not needed in
Convex.

The first UploadThing route is deliberately limited to one standalone HTML
file up to 8 MB. The testing tier uses public-read objects, so anyone who
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

## Deployment contract

Railway deploys from the repository root. The service should use:

```text
Build: npm run build --workspace @planview/app
Start: npm start --workspace @planview/app
Health check: /api/health
```

The current staging service is configured with that contract. It needs
`CONVEX_URL`, `CONVEX_SITE_URL`, `UPLOADTHING_TOKEN`, and the Convex staging
deployment's `SITE_URL` before GitHub OAuth and uploads can be tested. Set
`UPLOADTHING_CALLBACK_URL` to the public staging URL plus
`/api/uploadthing` only when automatic URL detection is not reliable.

## Current API surface

- `/api/auth/*` proxies Better Auth to the Convex site.
- `GET /api/documents` lists the signed-in user's documents.
- `GET` and `POST /api/uploadthing` expose the typed UploadThing file route.
- `POST /api/documents` records the uploaded HTML file in Convex metadata.
- `GET` and `DELETE /api/documents/:id` view or remove a workspace document.
- `/api/health` is the Railway health check.

Document previews are authorized through the user's Convex session and served
inline with a sandboxed, opaque origin. This lets agent-generated HTML run its
own scripts without giving it access to the app session or same-origin
application APIs. Existing Convex-backed records remain readable while the
new provider boundary is rolled out. Bundles and private storage are later
slices.
