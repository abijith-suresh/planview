import type { ReadStream } from "node:fs";
import type { DocumentId, DocumentIdRandomBytes } from "@planview/core";
import { Data } from "effect";
import type { Effect } from "effect";
import type { DocumentFileStore } from "./document-files.js";
import type { DocumentMetadata, MetadataStore } from "./metadata-contracts.js";
import type { MetadataGatedDocumentReader } from "./publication-reader.js";

export type DocumentPublicationResourceState = "retained" | "unknown";

export type DocumentPublicationResource = Readonly<{
  readonly id?: string;
  readonly handle?: string;
  readonly state: DocumentPublicationResourceState;
}>;

export type DocumentPublicationRecovery = Readonly<{
  readonly documentFiles: readonly DocumentPublicationResource[];
  readonly metadataRows: readonly DocumentPublicationResource[];
  readonly stagedFiles: readonly DocumentPublicationResource[];
  readonly finalizationLocks: readonly DocumentPublicationResource[];
}>;

/**
 * A state that a future reconciliation pass can inspect after a process crash
 * or an unsuccessful compensation. Resources are never guessed away after an
 * ambiguous boundary; `unknown` is retained with the same conservatism as an
 * observed resource.
 */
export type DocumentPublicationOrphanState = Readonly<{
  readonly kind:
    | "staged-file"
    | "document-file"
    | "metadata-row"
    | "document-file-and-staged-file"
    | "document-file-and-metadata-row"
    | "metadata-row-and-staged-file"
    | "finalization-lock";
  readonly id?: string;
  readonly handle?: string;
  readonly reason: "process-crash-window" | "compensation-failed";
  readonly resources: DocumentPublicationRecovery;
}>;

export type DocumentPublicationResult = Readonly<{
  readonly id: DocumentId;
  readonly metadata: Readonly<DocumentMetadata>;
}>;

export class DocumentPublicationError extends Data.TaggedError("DocumentPublicationError")<{
  readonly sourcePath: string;
  readonly id?: string;
  readonly handle?: string;
  readonly cause: unknown;
  readonly cleanupCause?: unknown;
  readonly orphan?: DocumentPublicationOrphanState;
  readonly message: string;
}> {}

export class DocumentPublicationRetryLimitError extends Data.TaggedError(
  "DocumentPublicationRetryLimitError"
)<{
  readonly sourcePath: string;
  readonly attempts: number;
  readonly cause: unknown;
  readonly message: string;
}> {}

export type DocumentPublicationCoordinatorOptions = {
  readonly documentFileStore: DocumentFileStore;
  readonly metadataStore: MetadataStore;
  readonly randomBytes?: DocumentIdRandomBytes;
  readonly generateId?: () => DocumentId;
  readonly now?: () => number;
  readonly maxAttempts?: number;
  /** Override SQLite/native uniqueness classification in tests or adapters. */
  readonly isMetadataUniquenessCollision?: (error: unknown) => boolean;
  /** A bounded, streaming size seam also makes read failures directly testable. */
  readonly readPublishedSize?: (
    id: DocumentId,
    documentFileStore: DocumentFileStore,
    signal?: AbortSignal,
    readTarget?: () => Promise<ReadStream>
  ) => Promise<number>;
};

export interface DocumentPublicationCoordinator extends MetadataGatedDocumentReader {
  readonly publish: (
    sourcePath: string,
    signal?: AbortSignal
  ) => Effect.Effect<
    DocumentPublicationResult,
    DocumentPublicationError | DocumentPublicationRetryLimitError
  >;
  readonly publishDocument: (
    sourcePath: string,
    signal?: AbortSignal
  ) => Effect.Effect<
    DocumentPublicationResult,
    DocumentPublicationError | DocumentPublicationRetryLimitError
  >;
}
