# Planview app

The authenticated product surface is a SolidStart 2 application. This first
slice is intentionally backend-free so it can be previewed before Better Auth,
Convex, and Railway are configured.

## Local development

From the repository root:

```sh
npm run dev --workspace @planview/app
```

The app currently exposes a polished sign-in state at `/` and a static dashboard
preview at `/dashboard`. The GitHub button is disabled until the Better Auth
server boundary is added.

## Deployment contract

The app builds a Node server with Nitro and starts with `npm start`. The eventual
Railway service should use the repository root, install with `npm ci`, build with
`npm run build --workspace @planview/app`, and start with
`npm start --workspace @planview/app`.
