# planview

## 0.1.2

### Patch Changes

- 79c59a3: Add `planview get` for streaming immutable snapshots by document id or exact local URL.
- 3942f49: Add authenticated 30-day snapshot cleanup, startup reconciliation, and automatic daemon retention maintenance.
- 8c42285: Add bundled `planview` and `create-html` Agent Skills with a safe
  `planview skills install` command.

## 0.1.1

### Patch Changes

- a3adeea: Integrate the pinned Effect 4 beta runtime at the CLI execution boundary while preserving existing help, version, and argument-error behavior.
- a3adeea: Add the initial installable CLI bootstrap with deterministic help and version output.
- 073e81b: Add `start`, `status`, `stop`, and `restart` commands for the private localhost daemon lifecycle.
- b29efcc: Add `publish <file>` to store immutable HTML snapshots and serve them from authenticated daemon-managed localhost URLs.
