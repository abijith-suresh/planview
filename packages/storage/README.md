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
remove their partial file while the trusted root remains available; if the root
is actively replaced, cleanup fails closed and may leave an orphan for later
policy-driven cleanup.

`finalizeStagedFile(handle, id)` validates both values and publishes with
`fs.link`, which is an atomic no-replace hard-link operation on the supported
local filesystems. It deliberately does not use `rename`: POSIX `rename` can
replace a target created concurrently. A per-handle atomic lock directory
contains owner/lease metadata. An expired lock
is recovered only after a 30-second lease plus a 5-second grace period, when its
metadata identifies this host and a process that is definitely gone; malformed,
unknown, or still-live locks are retained and reported as busy. Recovery renames the exact stale directory to a private quarantine before
removing its expected metadata, so it never removes an active lock by guessing.
The target must be a regular file, must not already exist, and must be on the same
hard-link-capable filesystem; there is no copy or unsafe rename fallback. The
staged name and lock are removed after publication when the trusted roots remain
available.

The staged file is synced before linking. On POSIX, the target directory and then
the staging directory are synced when Node and the filesystem support directory
`fsync`; `EINVAL`, `ENOSYS`, `ENOTSUP`, and `EOPNOTSUPP` mean that this specific
directory-sync guarantee is unavailable. Bad descriptors, non-directories, and
other I/O errors are failures, not unsupported cases. If target-directory sync
fails after linking, the still-unpublished target is removed before the failure is
reported. A later staging-directory cleanup-sync failure occurs after publication
and does not retract the document. On Windows, Node has no directory-handle sync
API here: file syncing and atomic hard-link behavior remain, but directory-entry
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
exhaustively classified through these APIs.

Each store operation takes a lease. `close()` rejects new operations immediately
and returns a promise that resolves only after already-started operations release
their leases; directory file descriptors are closed only then. This prevents a
close from invalidating an in-flight operation's descriptor. The returned streams
own their file descriptors independently of the store lease.

`readDocumentFile(id)` (also exposed as `readDocument`) validates the identifier
and returns a Node read stream rather than loading the document into memory.
`deleteDocumentFile(id)` validates the identifier and returns whether a regular
document was removed. Invalid IDs and handles are rejected before any owned path
is constructed. No database, daemon, publication URL, cleanup policy, or transport
is included in this boundary.

## Metadata

`openStorage(path)` remains the typed Effect boundary for the private SQLite
metadata store. It opens SQLite through Node 24's built-in `node:sqlite` module
and applies the versioned schema using `PRAGMA user_version`. The v1 table contains
only `id`, `createdAt`, `lastAccessedAt`, and `size`; metadata and document bytes
are intentionally not integrated in this slice. Metadata mutations use SQLite
transactions; query failures remain native SQLite errors rather than being wrapped
one by one.
