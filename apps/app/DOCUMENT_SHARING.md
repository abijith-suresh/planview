# Sharing documents

Workspace preview links require the owning account to sign in. Documents have no
app share link until the owner creates one. Hosted MCP exposes `share_document`
and `unshare_document`; agents should share only when the user asks.

The browser-session API provides `POST /api/documents/:id/share` to create a link
and `DELETE /api/documents/:id/share` to revoke it. CLI upload credentials cannot
use these endpoints. A workspace sharing button can use these APIs later.

Each creation returns a new `/s/:id/:token` link and replaces any previous link
for that document. Anyone holding the current link can view the document without
an account. The database stores a SHA-256 hash of the random 256-bit token rather
than the token itself. Deletion, revocation, and rotation deny subsequent viewing
requests. They cannot remove a copy someone already downloaded or opened.

Responses forbid caching, suppress referrers, and tell compliant search engines
not to index or follow the page. Unlisted links can still be forwarded, so use
them only for documents the owner is comfortable sharing.

UploadThing file URLs remain public during alpha. Revoking an app share link
does not revoke a direct storage URL. This feature does not make alpha uploads
private. The browser downloads document bytes directly from the storage provider
and renders them in a sandbox without access to the workspace session. A future
private provider must supply short-lived read URLs and browser CORS support; link
revocation then denies new URL issuance, while previously issued URLs remain
usable until they expire.
