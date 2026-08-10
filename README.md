# Planview

Planview is a TypeScript ESM monorepo for turning an HTML file into a persistent,
immutable localhost URL.

## Bootstrap status

Milestone 0 currently contains only the repository foundation: npm workspaces,
Node.js 24 pinning, shared strict TypeScript settings, Biome formatting/linting,
and runnable quality scripts. There is intentionally no application source or runtime package yet.

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

The current root check validates this foundation: formatting, linting, and a
Node built-in smoke test for the required configuration, files, and scripts. It
does not claim to typecheck or build future workspaces; there is no TypeScript
input yet. When workspace packages are added, each package must declare
`"type": "module"` and its checks must be explicitly wired into the root
orchestration.

## Planned structure

- `apps/cli` — public command-line package
- `apps/site` — documentation and project site
- `packages/*` — reusable implementation packages

Those workspaces, along with the application runtime and persistence layers, will
be introduced in later milestones.
