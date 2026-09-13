# @abijith-suresh/planview

## 0.1.4

### Patch Changes

- a2928c0: Keep CLI command composition in Effect and clean prepared sources after failed publications.
- af7ce8c: Route CLI operations through the reusable local Effect API.
- 51466a4: Improve the preview command guidance and missing-input message.
- 1bc8657: Expose daemon lifecycle and document operations as typed Effect programs.
- 1bc8657: Upgrade the CLI runtime to the current Effect v4 release candidate.
- 4437bb4: Expose publication and cleanup coordination as typed Effect programs.
- 7519d6d: Align Effect v4 boundaries with typed errors and propagate cancellation through daemon operations.

## 0.1.3

### Patch Changes

- dc770c3: Support publishing a page folder as one immutable bundle and serving its root page and assets.
- 83ea311: Typecheck CLI tests with Node TypeScript.
- 2c3b84c: Typecheck core package tests with Node TypeScript.
- adc3486: Keep local publishing and bundled skill installation working with native macOS and Windows paths.
- 3ed3dbf: Typecheck daemon package tests with Node TypeScript.
- b9e2f70: Add a `preview` command that publishes a file or page folder and opens its URL in the default browser.
- dc6d2b5: Harden detached daemon environment handling, request cancellation, and source-file staging.
- 26501b7: Reject daemon descriptor and lifecycle-lock reads when the opened file is not the file that was observed.
- 09ab8ea: Typecheck storage package tests with Node TypeScript.
- 2bc3a86: Discover repository tests from their workspace globs.

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
