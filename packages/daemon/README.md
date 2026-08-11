# @planview/daemon

Private daemon and publication implementation for Planview. It is bundled into
the published CLI and is not a published package API. The authenticated
management boundary coordinates the existing SQLite metadata store, immutable
document-file store, and publication coordinator.

The public v1 listener is always `127.0.0.1:4777`; the port is not configurable
through normal CLI options or environment variables. A test-only configuration
path is used by the hermetic process tests and is not part of the production
configuration contract.

On POSIX, Planview creates the app-data and runtime directories as `0700`,
requires them to be owned by the current UID, and writes the descriptor and
single lifecycle lock as `0600` files owned by that UID. Runtime state must remain below
the Planview app-data directory. The loopback listener also requires its random
secret for lifecycle and publish management endpoints. Published document ids
are served directly as HTML without an application wrapper; missing documents
return HTML 404 responses and other methods return 405.

Windows privacy is deliberately described honestly. Node does not provide a
portable API here to inspect or enforce NTFS ACLs or to classify every reparse
point, and its `mode`/`chmod` values are not an ACL guarantee. Under the PRD's
single-user local trust model, Windows deployments must provision an
account-owned app-data directory that is not writable by other users. Planview
claims loopback binding and authenticated lifecycle requests, but does not
claim that its Node-only checks enforce Windows filesystem privacy against a
hostile local user.
