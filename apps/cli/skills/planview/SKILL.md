---
name: planview
description: Publish, retrieve, and inspect immutable local HTML snapshots with the Planview CLI.
metadata:
  author: planview
  version: "0.1"
---

# Planview

Use Planview when an HTML artifact needs a stable, shareable URL on the local machine.
A publication is an immutable snapshot: changing the source file never changes a URL
that was already printed.

## Workflow

1. Confirm the input is a complete `.html` or `.htm` file no larger than 10 MiB.
2. Publish it and capture the URL:

   ```sh
   planview publish ./report.html
   ```

3. Use the printed `http://localhost:4777/<id>` URL in a local browser or hand the
   21-character id to another Planview command.
4. Retrieve exact bytes when a pipeline needs the snapshot:

   ```sh
   planview get <id-or-exact-local-url> > recovered.html
   ```

Planview starts its loopback-only daemon on demand. `start`, `status`, `stop`,
`restart`, and `clean` manage it explicitly; `status` is read-only and does not
start a daemon. `clean` applies the normal 30-day last-access retention policy.

## Safety rules

- Treat every published URL as immutable; publish again after changing source.
- Pass a real local HTML file, not a directory, symlink, URL, or generated shell
  substitution whose bytes have not been checked.
- Keep document ids and URLs exact. Do not append query strings or path segments.
- Never expose the daemon beyond loopback or put secrets in HTML intended for a
  shared screen.
- Check command failures on stderr and preserve stdout for URLs or retrieved bytes.
