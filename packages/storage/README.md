# @planview/storage

Private daemon-owned SQLite metadata storage for Planview. This package is not a
published API and deliberately stores document metadata only; document bytes,
publication, cleanup, and transport remain outside this slice.

It opens SQLite through Node 24's built-in `node:sqlite` module and applies the
versioned schema using `PRAGMA user_version`. The v1 `documents` table contains
only `id`, `createdAt`, `lastAccessedAt`, and `size`, all with integer epoch
millisecond or non-negative integer constraints as appropriate.

`openStorage(path)` is the typed Effect boundary for path, open, and migration
failures. The returned synchronous `MetadataStore` owns the connection and must
be closed by its caller. Metadata mutations use SQLite transactions; query
failures are intentionally left as native SQLite errors rather than being
wrapped one by one.
