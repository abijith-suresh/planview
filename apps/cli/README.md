# Planview CLI

The public `planview` command-line package. It publishes immutable HTML
snapshots through the private localhost daemon:

```sh
npx planview publish ./report.html
# http://localhost:4777/<id>
```

The daemon can also be managed directly:

```sh
npx planview start
npx planview status
npx planview stop
npx planview restart
npx planview clean
```

The daemon is detached, bound only to the fixed `127.0.0.1:4777`, and stores
its protected runtime descriptor below the persistent Planview app-data
directory. `publish` validates the `.html`/`.htm` source and inclusive 10 MiB
limit before starting the daemon, then prints only the resulting localhost URL.
`get` accepts a document id or exact local Planview URL and writes only the
stored HTML bytes to stdout; invalid references and missing documents fail on
stderr. `clean` starts or reuses the daemon and invokes its authenticated
30-day-last-access retention and startup-reconciliation policy, printing a
human-readable summary to stdout. `status` does not start a daemon; `start`
reuses an authenticated daemon it owns and never terminates an unknown process
listening on the port.

The package also bundles independent `planview` and `create-html` Agent Skills.
Install both into `~/.agents/skills` with:

```sh
planview skills install
```

Installation refuses to replace an existing skill directory. Use
`planview skills install --force` for an explicit replacement. The installer
creates missing home parents, requires the destination parents to be owned by
the current user and not writable by group/other, stages both trees privately,
and uses a durable journal plus a per-destination lock. A later invocation
recovers an interrupted transaction before inspecting or changing either skill.
It rejects static symlinks and unsafe ownership/modes and never follows links
while copying the bundle.

The lock serializes cooperating Planview installers, but it is not a lock on
readers of `~/.agents/skills`. Portable Node has no atomic operation that
replaces two sibling directories at once, so a reader that ignores the lock can
briefly observe one old and one new tree (or one tree missing) while a commit is
in progress. The journal makes normal installer crashes recoverable to the
previous or committed generation; it cannot provide directory-level atomicity
or protect against a hostile external process replacing paths between Node's
checks and filesystem operations. That replacement race is outside the PRD's
single-user v1 trust model. Windows mode/ownership values and reparse-point
classification likewise remain platform limitations, so Windows users must
provision an account-owned, non-user-writable home/destination.

On POSIX, the app-data and runtime directories are owned by the current UID and
protected with `0700`; descriptor and lock files are owned by that UID and
protected with `0600`. Windows does not expose a portable Node API for enforcing
NTFS ACLs or classifying every reparse point, so those mode values are not a
Windows privacy guarantee. Consistent with the PRD's single-user local trust
model, Windows users must provision an account-owned, non-user-writable app-data
directory. Planview claims loopback binding and authenticated lifecycle
requests, not hostile-local-user filesystem isolation on Windows.

## Published artifact

The private daemon workspace is bundled into the CLI's `dist` artifact during
build and pack. The published package includes the Agent Skills under `skills/`
and therefore has no runtime dependency on a private `@planview/*` workspace.
