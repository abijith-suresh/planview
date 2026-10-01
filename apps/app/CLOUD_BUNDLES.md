# Cloud artifacts

The CLI accepts `planview upload ./artifact/`. Hosted MCP provides `upload_bundle`
with `title` and `files`, each containing `path` and UTF-8 `content`. Both store one
PLVWBND1 object using the same format as local artifact previews. Standalone HTML
uploads keep their existing API and behavior.

A bundle requires root `index.html`, at most 512 files, and 8 MiB including the
manifest. Paths use ASCII letters, digits, dots, underscores, hyphens, and `/`
folders. Traversal, duplicates, encoded URL aliases, unsupported file extensions,
symlinks, and changing folders are rejected before storage publication. The CLI
supports HTML/CSS/JS/MJS, JSON/text/SVG, common images/fonts, and MP4/WebM assets.
MCP accepts UTF-8 text assets only. A whole bundle counts against the same account
quota, with admission before provider uploads and the same signed completion,
ambiguous-outcome, and cleanup handling as standalone HTML.

`list_documents` identifies artifacts with `kind: "bundle"`. `list_bundle_files`
returns at most 50 paths per page with `nextOffset`. `read_document` defaults to
`index.html`; its optional `path` selects a text asset. The existing `html` field
contains that text and retains character pagination. Binary entries can be listed
and viewed by the browser, but cannot be returned as UTF-8 text through MCP.

The stable owner preview URL checks the session and redirects to an authenticated
encrypted read capability lasting five minutes. Claims bind document, owner,
storage provider, locator, and expiry without exposing provider locators in the
URL. Each asset request verifies the capability and current owner metadata before
cache access. Deleted documents stop serving new assets. Reopen the stable owner
URL to renew an expired preview.

Relative stylesheets, classic scripts, and JavaScript module imports resolve from
the artifact entry path. HTML runs in an opaque-origin CSP sandbox. Module assets
permit CORS from `Origin: null`; responses have correct MIME types, nosniff,
private no-store, noindex, and no-referrer headers. Generated scripts can still
load HTTPS resources, so artifacts are not necessarily offline.

The separate sharing feature can point a public link at `/api/shared-bundles/`.
Every asset request resolves its current sharing token before cached reads. Link
rotation, revocation, and deletion deny new asset reads; without the sharing
backend the route returns 404. Already downloaded copies remain available.

Bundle assets currently pass through the app service. One process retains at most
two bundle objects of at most 8 MiB each, permits two concurrent provider reads,
and expires cache entries after one minute. This fallback preserves browser
relative-URL behavior but consumes Railway service bandwidth. UploadThing storage
and delivery charges still apply, and its alpha object URLs remain public. A later
provider can supply directly served artifact entries or a CDN without changing
document identity; this release does not promise private files or zero egress cost.
