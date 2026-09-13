# Planview CLI contract

This document records the behavior that scripts and agents may rely on. The
man page and `planview help` explain how to use the CLI. Tests enforce this
contract.

## Invocation

```text
planview <command> [options]
```

Options may appear before or after operands. `--` ends option parsing, so the
remaining arguments are always operands.

The CLI accepts `-h` and `--help` for the root command and every command. It
also accepts `planview help [command]`. `-v` and `--version` are root options.

## Streams and exit status

- Successful command output goes to stdout.
- Errors go to stderr.
- `get` writes only the stored document bytes to stdout.
- Exit status `0` means success.
- Exit status `1` means invalid arguments or an operation failure.

Text output contains no progress messages or logs. A command that accepts
`--json` writes one JSON value followed by a newline.

## Commands

### `publish <file|folder>`

Publishes an immutable HTML file or page folder and prints its URL. A folder
must contain `index.html`.

Text stdout:

```text
http://localhost:4777/<id>
```

JSON stdout with `--json`:

```json
{"id":"<id>","url":"http://localhost:4777/<id>"}
```

### `preview <file|folder>`

Publishes the same snapshot as `publish`, prints the URL, and opens it in the
platform's default browser. Its JSON result has the same shape as `publish`.

### `get <id|url>`

Retrieves a stored snapshot and writes its exact bytes to stdout. It accepts a
document id or an exact local Planview URL. It does not accept `--json`.

### Daemon commands

`start`, `status`, `stop`, `restart`, and `clean` manage or inspect the local
daemon. `status` never starts the daemon.

With `--json`, `status`, `start`, and `restart` use this running-state shape:

```json
{
  "state":"running",
  "host":"127.0.0.1",
  "port":4777,
  "pid":12345,
  "startedAt":1730000000000
}
```

`start` also includes `reused`, which is `true` when it reused an existing
daemon. `stop --json` returns `{"state":"stopped"}`. `status --json`
returns the same stopped value when no daemon is running.

`clean --json` returns the cleanup counters and a `failures` array. Each
failure contains `phase`, an optional `id`, and `message`; internal causes are
not part of the public JSON output.

### `skills install [--force]`

Installs the bundled Agent Skills into `~/.agents/skills`. It refuses existing
skill directories unless `--force` is supplied. This command does not support
`--json`.

## JSON errors

When `--json` is present, errors use this shape on stderr:

```json
{"error":{"code":"UnknownOptionError","message":"Unknown option: --bad","option":"--bad"}}
```

The error `code` is the stable discriminator. Error-specific fields are
included when they identify the failed command or input.
