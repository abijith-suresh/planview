# Planview app

The authenticated product surface is a SolidStart 2 application. It now has a
real Better Auth and Convex boundary, a private documents table, and a first
upload path for standalone `.html` files.

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
`CONVEX_URL`, `CONVEX_SITE_URL`, and the Convex staging deployment's
`SITE_URL` before GitHub OAuth can be tested.

## Current API surface

- `/api/auth/*` proxies Better Auth to the Convex site.
- `GET /api/documents` lists the signed-in user's documents.
- `POST /api/documents/upload-url` creates a short-lived Convex upload URL.
- `POST /api/documents` records the uploaded HTML file.
- `GET` and `DELETE /api/documents/:id` view or remove a private document.
- `/api/health` is the Railway health check.

Document content is authorized through the user's Convex session. Previews are
served inline with a sandboxed, opaque origin. This lets agent-generated HTML
run its own scripts without giving it access to the app session or same-origin
application APIs. The first pass deliberately supports one standalone HTML
file; bundles and object storage migration are later slices.
