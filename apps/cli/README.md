# Planview CLI

The public `planview` command-line package. This milestone provides the
installable CLI baseline with deterministic help and version output; application
subcommands arrive in later milestones.

```sh
npx planview --help
npx planview --version
```

## Effect boundary

The CLI pins the Effect 4 beta core package at `4.0.0-beta.107`. This is an
intentional exact beta pin rather than a range: Effect 4 is still pre-release,
and keeping the upgrade point explicit prevents a lockfile refresh from
silently changing its API. The package is exercised on the repository's Node
24.19.0 baseline. Only the core `effect` package is used; platform and CLI
packages from the Effect 3 line are not compatible with this slice.

`run` is the import-safe command program. It returns an
`Effect<number, CliError>`: output callbacks are sequenced at the boundary and
argument failures are tagged, typed Effect failures. Help and version formatting
remain pure string formatting, so the Effect integration does not turn static
text into an unnecessary abstraction. `main` is the small process boundary that
uses the Effect runtime, handles those typed failures, and returns the existing
exit codes. The executable guard remains import-safe, while the built bin runs
that boundary through `Effect.runSync`.
