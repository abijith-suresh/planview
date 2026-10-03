# plansplease CLI

The public `@abijith-suresh/planview` command-line package. It publishes immutable,
30-day-last-access-retained HTML snapshots through the private localhost daemon and
can upload HTML files or artifact folders to the alpha cloud workspace:

The command is `plansplease`. This release replaces the `planview` executable;
update existing scripts to use `plansplease`. Existing profiles, local documents,
saved cloud credentials, daemon state and installed skills keep their locations.
The command is installed from the existing `@abijith-suresh/planview` package;
npm publication remains disabled.

Build and install a tarball from the repository using Node.js 24.19.0 and npm 11.16.0:

```sh
git clone https://github.com/abijith-suresh/planview.git
cd planview
npm ci
npm pack --workspace @abijith-suresh/planview --pack-destination .
```

Replace `FILE.tgz` with the filename printed by `npm pack`:

```sh
npm install --global --ignore-scripts ./FILE.tgz
plansplease --version
```

```sh
plansplease publish ./report.html
# http://localhost:4777/<id>

# A folder publishes index.html and its assets as one snapshot
plansplease publish ./site
# http://localhost:4777/<id>

# Publish and open the URL in the default browser
plansplease publish --open ./site

# Sign in, then upload an HTML page or a folder containing index.html
plansplease login
plansplease upload ./report.html
plansplease upload ./artifact/
# https://plansplease-app-staging.up.railway.app/api/documents/<id>

# Keep a feature build separate from the default installation
plansplease --profile feature publish ./site

```

The current staging app is `https://plansplease-app-staging.up.railway.app`.
The CLI recognizes its previous Railway hostname and uses the replacement origin
for saved staging credentials, including upload and logout. This does not change
credentials for custom cloud origins or send them to an environment override.

Get help for the whole CLI or for one command:

```sh
plansplease help
plansplease help publish
plansplease publish --help
plansplease help upload
```

Commands that return metadata also support one JSON object on stdout:

```sh
plansplease publish --json ./report.html
plansplease upload --json ./report.html
plansplease status --json
```

The package includes a Unix manual page. On npm versions that register package
man pages, a global install makes it available as:

```sh
man plansplease
```

`plansplease help` is the portable help path. Newer npm versions may keep the
manual in the package without registering it with the system `man` command.

## Automation contract

Successful results go to stdout. Errors go to stderr. Exit status `0` means
success; exit status `1` means invalid input or an operation failure. `get`
writes only the stored document bytes to stdout.

Global options must appear before the command. Command options may appear
before or after operands. `--` ends command option parsing, and an
unknown option fails before the command starts work. Commands that accept
`--json` write one newline-terminated JSON value. For example:

```json
{"id":"<id>","url":"http://localhost:4777/<id>"}
```

`status --json` reports either `{"state":"stopped"}` or a running daemon
with its `profile`, `host`, `port`, `pid`, and `startedAt`. `start --json` adds `reused`.
`stop --json` reports the stopped state. `clean --json` returns cleanup counts
and failure messages without internal causes. `publish --open` keeps the
normal publish result and adds the browser-opening side effect.

## Cloud uploads

`plansplease login` opens GitHub sign-in in a browser and asks you to authorize the
local CLI. The CLI stores the cloud credential in the selected profile's
Planview data directory. On POSIX systems the directory is mode `0700` and the
credential file is mode `0600`. The credential permits cloud uploads only and
stays valid until revoked. `plansplease logout` revokes it on the cloud service,
then removes the local file; it needs a connection to complete. Renaming the
command does not require signing in again.
Set `PLANVIEW_CLOUD_URL` or pass `--cloud-url <origin>` to `plansplease login` to
use another cloud app. The alpha default is
`https://plansplease-app-staging.up.railway.app`.

`plansplease upload <file.html>` accepts one standalone `.html` file up to 8 MiB
and returns its workspace preview link. The preview requires the same account to
be signed in in the browser; it is not an anonymous share link. Use `--open` to
open the returned link or `--json` to print the document ID and URL.

The daemon can also be managed directly:

```sh
plansplease start
plansplease status
plansplease stop
plansplease restart
plansplease clean
```

The daemon is detached and binds to `127.0.0.1:4777` when available. If that
port is occupied, it tries the next 50 ports and stores the selected port in
the protected runtime descriptor. The URL printed by `publish` always uses
the selected port. Each profile has its own durable app-data and runtime
directory; the default profile keeps the existing Planview data location and
named profiles live below `planview/profiles/<name>`. The existing `PLANVIEW_*`
environment settings and local directories retain their names. `publish` validates the `.html`/`.htm` source and inclusive 10 MiB
limit before starting the daemon, then prints only the resulting localhost URL.
When the input is a folder, it must contain `index.html`; the folder is packed
into one immutable snapshot, with asset paths available below `/<id>/`.
`get` accepts a document id or exact local Planview URL for the selected
profile and writes only the stored HTML bytes to stdout; invalid references,
URLs from another active profile, and missing documents fail on stderr. `clean` starts or reuses the daemon and invokes its authenticated
30-day-last-access retention and startup-reconciliation policy, printing a
human-readable summary to stdout. `status` does not start a daemon; `start`
reuses an authenticated daemon it owns and never terminates an unknown process
listening on the port.
The package also bundles independent `planview` and `create-html` Agent Skills.
Install both into `~/.agents/skills` with:

```sh
plansplease skills install
```

Installation refuses to replace an existing skill directory. Use
`plansplease skills install --force` for an explicit replacement. The installer
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
and therefore has no manifest or TypeScript-declaration dependency on a private
`@planview/*` workspace.

Cloud artifact folders require `index.html`. HTML, CSS, JavaScript, modules, JSON,
text, SVG, common images, fonts, and MP4/WebM assets are supported. Paths use ASCII
letters, digits, dots, underscores, hyphens, and `/` folders. Symlinks and changing
folders are rejected. One encoded bundle, including its manifest, must fit within
8 MiB and 512 files. The whole object counts against the account storage limit.
Relative CSS, classic scripts, and module imports resolve within the artifact.
The returned workspace URL requires owner sign-in; its preview issues a five-minute
read capability. Reopen the workspace URL when that capability expires.
