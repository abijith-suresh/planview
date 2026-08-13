# Contributing

## Changesets

User-facing changes to the public `@abijith-suresh/planview` package need a
Changeset. Run `npm run changeset`, select `@abijith-suresh/planview`, and choose
`patch`. Until the package reaches `1.0.0`, Planview uses patch-only releases. The automated
`npm run release-policy` check enforces that rule for pending Changesets; it
ignores Changesets' README/config files and entries for other (including
private) packages.

Keep the published package name as `@abijith-suresh/planview` (`apps/cli/package.json`);
the CLI binary remains `planview`, and the private workspace is named
`planview-workspace`.

Before opening a change, run:

```sh
npm ci
npm run verify
npm run changeset:status
npm run pack:check
```

`npm run verify` runs the release-policy check. The same check runs before
`npm run version-packages` and `npm run release`, so a pre-1.0.0 minor or major
`@abijith-suresh/planview` Changeset cannot be versioned or published accidentally.

Changesets are versioned and published by maintainers. See
[RELEASING.md](RELEASING.md) for the release procedure.
