# @abijith-suresh/planview

## 0.1.2

### Patch Changes

- 79c59a3: Add `planview get` for streaming immutable snapshots by document id or exact local URL.
- 8d11eee: Add a fixed v1 storage quota that rejects publications safely when retained snapshots would exceed the logical 1 GiB limit.
- 3942f49: Add authenticated 30-day snapshot cleanup, startup reconciliation, and automatic daemon retention maintenance.
- cbdcc02: Harden detached daemon startup and cleanup recovery, keep private workspace details out of the public declaration, and clarify local snapshot retention behavior.
- 8c42285: Add bundled `planview` and `create-html` Agent Skills with a safe
  `planview skills install` command.
- 42fc383: Bound daemon shutdown across in-flight publication and cleanup operations, cancel request pipelines safely, and retain atomic publication recovery and descriptor cleanup.
- 5ed1708: Batch snapshot cleanup with indexed, resumable retention candidates and bounded reconciliation work.
- 79ba794: Allow stalled snapshot downloads to be aborted and bounded without blocking unrelated publish and cleanup operations; retain read protection through post-transfer access tracking.

## 0.1.1

### Patch Changes

- a3adeea: Integrate the pinned Effect 4 beta runtime at the CLI execution boundary while preserving existing help, version, and argument-error behavior.
- a3adeea: Add the initial installable CLI bootstrap with deterministic help and version output.
- 073e81b: Add `start`, `status`, `stop`, and `restart` commands for the private localhost daemon lifecycle.
- b29efcc: Add `publish <file>` to store immutable HTML snapshots and serve them from authenticated daemon-managed localhost URLs.
