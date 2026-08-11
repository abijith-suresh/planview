# @planview/core

Private Planview primitives shared by later publication work. This package has no
file-system inspection or copying behavior.

## Document identifiers

`generateDocumentId()` creates a cryptographically random NanoID-style document
identifier: exactly 21 characters from the URL-safe alphabet (`A-Z`, `a-z`,
`0-9`, `_`, and `-`). `validateDocumentId()` and `isValidDocumentId()` enforce
that shape strictly. Generation accepts an optional `randomBytes` dependency so
callers can use deterministic bytes in tests; it does not track uniqueness or
retry collisions. Uniqueness belongs to the persistence boundary.

## Source-file policy

`validateSourceFileExtension()` accepts only `.html` and `.htm`. Extensions are
matched case-insensitively (`INDEX.HTML` is accepted), which follows normal
cross-platform CLI expectations while preserving the original path. Both `/`
and `\\` separators are recognized when identifying the final path component;
this is parsing only, not file access.

`validateSourceFileSize()` accepts non-negative integer byte sizes up to and
including `V1_MAX_HTML_SIZE_BYTES` (10 MiB). `validateSourceFile()` combines the
extension and size checks. These validators do not inspect, read, or copy files.
Unsupported extensions, invalid sizes, and oversized files produce distinct
error classes with stable `code` values.
