# @planview/storage

Private daemon-owned storage for Planview. This package is not a published API.

## Document files

`openDocumentFileStore({ documentsDir, stagingDir })` creates and owns two absolute
storage directories. On POSIX it rejects symlinked path components, requires the
roots to be owned by the current user, rejects writable ancestors that are not
sticky directories, and applies `0700` to the roots. Staged files are `0600`.
These are mode-bit and owner checks; extended ACLs are outside Node's standard
inspection API. On Windows, Node's `mode`/`chmod` values do **not** express or
verify NTFS ACLs, and Node does not expose a portable reparse-point inspection
API. Windows privacy therefore depends on the caller provisioning application
account-owned, non-user-writable ACLs and on the PRD's single-user local trust
model; this package does not claim to enforce those properties.

`stageSourceFile(path)` validates the extension, checks every existing source path
component with `lstat`, rejects symlinks and non-regular files, and streams bytes
from the opened `.html` or `.htm` regular file into a random opaque staging handle.
The inclusive maximum is 10 MiB; the initial size and every streamed byte are
checked, and the source is checked again after streaming for identity and size
changes. FIFO/device opens are rejected before opening; the Unix open also uses
`O_NONBLOCK` and `O_NOFOLLOW` for the remaining replacement window. Windows has
no Node `O_NONBLOCK` equivalent, so a hostile replacement race there is covered
only by the post-open checks and the local-trust limitation. Failed stages
remove their partial file while the trusted root remains available; cleanup is serialized with finalization and compares the staged
device/inode identity plus birthtime when available before unlinking. If the pathname was replaced or the root is
actively replaced, cleanup fails closed and may leave an orphan for later
policy-driven cleanup.

`finalizeStagedFile(handle, id)` validates both values and publishes with
`fs.link`, which is an atomic no-replace hard-link operation on the supported
local filesystems. On success it returns an opaque target identity capability;
coordinator compensation must use that capability rather than deleting by
pathname. The private optional target-commit callback runs while the id-wide
target lock is still held; the publication coordinator uses it to measure the
linked target and commit metadata before cleanup can acquire that lock. Its
provided target reader is valid only until that callback resolves. Callers that
finalize without a callback retain the lower-level physical-file boundary and
must use the publication coordinator for metadata visibility. It deliberately
does not use `rename`: POSIX `rename` can replace a target created concurrently.
Per-handle and per-target atomic lock directories
contain owner/lease metadata. An expired lock
is recovered only after a 30-second lease plus a 5-second grace period, when its
metadata identifies this host and a process that is definitely gone; malformed,
unknown, or still-live locks are retained and reported as busy. Recovery first creates one fixed-name `O_EXCL` claim inside the inspected lock
directory; that single exclusive transition gives at most one recovery attempt
ownership. It then rechecks the lock inode identity. A concurrent replacement
therefore cannot be claimed or removed by pathname; a replacement or failed
identity check is retained as busy. The claim is released with the owner
metadata only by the claimant; a well-formed claim left by a crashed recovery
attempt is reaped after its own lease and grace period when its owner is
definitely gone, while malformed or unknown claims remain busy.
The target must be a regular file, must not already exist, and must be on the same
hard-link-capable filesystem; there is no copy or unsafe rename fallback. The
staged name and lock are removed after publication when the trusted roots remain
available. Target compensation requires the identity captured from the target
inspection immediately after linking; an unavailable or ambiguous inspection is
reported as unknown rather than cleaned up by document-id pathname.

The staged file is synced before linking. On POSIX, the target directory and then
the staging directory are synced when Node and the filesystem support directory
`fsync`; `EINVAL`, `ENOSYS`, `ENOTSUP`, and `EOPNOTSUPP` mean that this specific
directory-sync guarantee is unavailable. Bad descriptors, non-directories, and
other I/O errors are failures, not unsupported cases. If target-directory sync
fails after linking, the still-unpublished target is removed before the failure is
reported. After target-directory sync succeeds, the target is the recoverable
durable result: a later staging-directory cleanup-sync failure does not retract
it. The typed finalization error reports `targetRecoveryPolicy: "retain"` and
precise retained/unknown target, staged-file, per-handle-lock, and per-target-lock
states, so publication compensation must preserve the target even when metadata
is absent. On Windows, Node has no directory-handle sync API here: file syncing
and atomic hard-link behavior remain, but directory-entry
crash durability is not promised.

On Linux installations with `/proc/self/fd`, the store holds trusted directory
file descriptors and operates through that directory-fd view. Replacing the
configured root path cannot redirect that handle-relative view, although the
operation fails closed if the configured path no longer passes the trust checks.
If that view is unavailable, and on other platforms including Windows, Node does
not expose a portable `openat`/directory-handle-relative or no-reparse-point
primitive. The store rejects symlinks observed by `lstat`, validates canonical
roots, POSIX ownership/mode policy, and file identity before and after opens, and
uses `O_NOFOLLOW` where Node supports it. These checks detect many races but do
not make an impossible absolute-containment claim against a concurrent hostile
filesystem change on the fallback platforms. That is an unavoidable Node
limitation accepted by the PRD's single-user local trust model. Source paths
outside the store receive the same checks; Windows reparse points cannot be
exhaustively classified through these APIs. These checks detect many races but
cannot close every residual path TOCTOU window against a malicious same-user
process continuously replacing Planview-owned paths. That hostile filesystem
behavior is outside the trusted v1 model: Planview does not add native OS code
or fail Windows merely to defend against it.

Each store operation takes a lease. `close()` rejects new operations immediately
and returns a promise that resolves only after already-started operations release
their leases; directory file descriptors are closed only then. This prevents a
close from invalidating an in-flight operation's descriptor. The returned streams
own their file descriptors independently of the store lease.

`readDocumentFile(id)` (also exposed as `readDocument`) validates the identifier
and returns a Node read stream rather than loading the document into memory. It is
the physical-file primitive and must not be used as a published read boundary.
`deleteDocumentFile(id, capability?)` validates the identifier and returns
whether a regular document was removed. Its typed failure reports both target
and target-lock state for recovery accounting. When a capability is supplied, deletion
rechecks the finalized inode identity and retains a replacement instead of
unlinking it. Reads publish a private, identity-checked reference while the
stream is active, and target deletion takes the same id-wide lock before
checking those references; this protects normal same-user operations across
store instances. Startup reconciliation removes read references whose local
owner is definitely dead after a crash, while retaining malformed, foreign, or
live-owner markers. The daemon additionally holds its operation gate across the
HTTP response so cleanup cannot remove an active read. Target deletion is serialized with finalization and with the publication
metadata handoff: a cleanup candidate whose metadata row is not visible yet
can only delete after the publisher's same-id target lock is released, at which
point the row is committed or the publisher's failure path has retained a
recoverable target. `cloneStagedFile`
and `discardStagedFile` are required store operations: publication never falls
back to reopening caller input or silently skips owned cleanup. Invalid IDs and
handles are rejected before any owned path
is constructed. No daemon, publication URL, or transport is included in this
boundary; the private cleanup coordinator composes these primitives without
exposing them as a public file API.

## Publication coordination

`createDocumentPublicationCoordinator({ documentFileStore, metadataStore })` is a
private composition boundary for the first user-visible storage operation. It
stages source bytes once, clones that immutable staging snapshot for bounded ID
collision retries, finalizes a document file, measures the finalized bytes, and
inserts immutable SQLite metadata. It returns a frozen `{ id, metadata }` result
only after file finalization and metadata insertion have completed. Source input
is only opened for reading and is never removed or modified; the snapshot also
means that deletion or mutation of the input cannot change a retry.

The coordinator skips IDs occupied by a metadata preflight, retries no-replace
document-file collisions, and retries SQLite ID uniqueness collisions only after
metadata absence is observed. A unique database exception with a present or
unreadable row is otherwise ambiguous: it is never silently retried, and a
possible file/metadata pair is retained behind a typed recoverable error. Matching id, timestamp, and size fields are not an ownership
proof; without a private insertion token the bounded behavior is to retain the
possible pair as unknown rather than retrying or declaring success. Normal
failures compensate the created document file only with the identity
capability returned by finalization, and compensate every owned staged handle
whose lock and inode state is known safe; unknown residuals are reported for
recovery. A generic stage-adapter failure is treated as possibly having created
an unidentifiable staged file, so the recovery error includes an anonymous
`unknown` staged resource rather than silently discarding that possibility.
Compensation failures are elevated
with structured `orphan.resources` entries for all retained or uncertain
files, metadata rows, staged handles, and finalization locks; no ambiguous row
is deleted by guessing. ID generation, the clock, collision classification,
published-size reading, and the stores are injected seams for deterministic
fault testing. The private store seam reports typed partial clone/finalization
errors; a generic adapter fault is treated as possibly retaining every known
and unidentifiable staged file or lock.

Use `createMetadataGatedDocumentReader` or the coordinator's
`readPublishedDocument` for every later published read. It proves metadata
presence before opening the physical file, so a finalized file without a
committed row is not exposed. A row whose file is missing fails as a read error;
the seam never turns physical presence into publication success.

Filesystem publication and SQLite commit are different durability domains. The
coordinator deliberately does **not** claim a cross-filesystem atomic
transaction. Exact remaining crash properties are: a crash after staged-file
sync can leave a staged snapshot; after target-link/directory sync and before
metadata commit it can leave a physical file with no row (the gated reader
rejects it), but a live cooperating publisher holds the target lock across this
handoff so cleanup cannot remove that target; a post-publication staging-
directory sync failure can leave that recoverable target with unknown
staging/lock durability and no row (the coordinator never deletes the target
under the retain policy); after metadata
commit and before snapshot cleanup it can leave a valid published pair plus
duplicate staging; and a crash or thrown error at the metadata boundary can
leave an unknown pair. Lock metadata/claims and directory
entries have the platform-specific sync limits described above. The cleanup
coordinator reconciles these known states conservatively: metadata-gated reads
make uncommitted files invisible, stale locks are reclaimed only with the same
liveness/lease proof as publication, dead local read markers are reconciled, and
active reads or target locks are retained. It applies the fixed 30-day `lastAccessedAt` policy through an
injected clock and reports, rather than guesses through, filesystem faults.

## Fixed v1 storage quota

Committed snapshots have a fixed 1 GiB logical storage ceiling. Admission charges the
published HTML byte count plus 4 KiB per document for its SQLite metadata row,
generation token, and indexes. The charge is checked in the same `BEGIN IMMEDIATE`
transaction that inserts the metadata row, so concurrent daemon/storage instances
cannot both spend the same remaining capacity. Retention deletion releases the row's
charge in its transaction; no user configuration, quota command, or UI is added.
Staging and finalization remain bounded by the existing 10 MiB per-source limit, and
uncommitted/orphaned files remain invisible to readers and are handled by normal
reconciliation rather than being counted as active documents. A quota rejection is
reported as a publish error with the fixed limit and remaining capacity. Retention
continues to use the normal fixed 30-day last-access policy.

Retention candidates use a
`lastAccessedAt, id` SQLite index and bounded tuple-cursor pages; cleanup has fixed item/time budgets and
returns `resumable` when the next invocation must continue. Metadata and document reconciliation advance
through bounded id pages instead of building a full metadata catalog. Document-file pages use a
fixed id fence plus a strict filesystem birth-time fence for pass membership; equal, coarse, or
unavailable birth times are conservatively deferred to a later pass rather than being admitted
as snapshot members. The cleanup benchmark runs full cleanup for 1,000 and 10,000 rows and reports
wall time, batches, reclaimed bytes, and before/peak/after
RSS and heap memory with `npm run benchmark:cleanup --workspace @planview/storage`.
Tests labeled concurrent Planview operations cover cooperating store instances
and normal lock/collision races. Tests labeled out-of-model hostile external
replacement deliberately simulate a malicious same-user filesystem process; they
verify fail-closed diagnostics and preservation where possible, not a v1
containment guarantee.

## Metadata

`openStorage(path)` remains the typed Effect boundary for the private SQLite
metadata store. It opens SQLite through Node 24's built-in `node:sqlite` module
and applies the versioned schema using `PRAGMA user_version`. The v2 documents table
still contains only `id`, `createdAt`, `lastAccessedAt`, and `size`; a small
`document_generations` side table supplies an immutable conditional-deletion token for
cleanup, including ABA-safe delete/reinsert races. The `(lastAccessedAt, id)` index is
created transactionally while upgrading v1. Metadata mutations use SQLite transactions;
query failures remain native SQLite errors rather than being wrapped one by one.
