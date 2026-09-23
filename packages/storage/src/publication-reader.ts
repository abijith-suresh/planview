import type { ReadStream } from "node:fs";
import { type DocumentId, validateDocumentId } from "@planview/core";
import { Data, Effect } from "effect";
import type {
  DocumentFileFormat,
  DocumentFileReadLease,
  DocumentFileStore,
} from "./document-files.js";
import type { DocumentMetadata, MetadataStore } from "./metadata-contracts.js";

export class DocumentPublicationNotFoundError extends Data.TaggedError(
  "DocumentPublicationNotFoundError"
)<{
  readonly id: string;
  readonly message: string;
}> {}

export class DocumentPublicationReadError extends Data.TaggedError("DocumentPublicationReadError")<{
  readonly id: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export type MetadataGatedDocumentReaderOptions = Readonly<{
  readonly documentFileStore: DocumentFileStore;
  readonly metadataStore: MetadataStore;
}>;

export interface MetadataGatedDocumentReader {
  readonly readPublishedDocument: (
    id: DocumentId
  ) => Effect.Effect<ReadStream, DocumentPublicationReadError | DocumentPublicationNotFoundError>;
  /** Holds active-read protection until a post-transfer action is complete. */
  readonly readPublishedDocumentLease: (
    id: DocumentId
  ) => Effect.Effect<
    DocumentFileReadLease,
    DocumentPublicationReadError | DocumentPublicationNotFoundError
  >;
  readonly inspectPublishedDocument: (
    id: DocumentId
  ) => Effect.Effect<
    DocumentFileFormat,
    DocumentPublicationReadError | DocumentPublicationNotFoundError
  >;
  readonly readPublishedDocumentEntryLease: (
    id: DocumentId,
    path: string
  ) => Effect.Effect<
    DocumentFileReadLease,
    DocumentPublicationReadError | DocumentPublicationNotFoundError
  >;
}

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export const createMetadataGatedDocumentReader = (
  options: MetadataGatedDocumentReaderOptions
): MetadataGatedDocumentReader => {
  const { documentFileStore, metadataStore } = options;
  const readPublishedDocumentLeasePromise = async (id: DocumentId) => {
    let documentId: DocumentId;
    try {
      documentId = validateDocumentId(id);
    } catch (cause) {
      throw new DocumentPublicationReadError({
        id: String(id),
        cause,
        message: `Could not read published document ${String(id)}: ${describe(cause)}`,
      });
    }

    let metadata: DocumentMetadata | undefined;
    try {
      metadata = metadataStore.getDocumentMetadata(documentId);
    } catch (cause) {
      throw new DocumentPublicationReadError({
        id: documentId,
        cause,
        message: `Could not establish publication metadata for ${documentId}: ${describe(cause)}`,
      });
    }
    if (metadata === undefined) {
      throw new DocumentPublicationNotFoundError({
        id: documentId,
        message: `Document ${documentId} is not a committed publication.`,
      });
    }

    try {
      return await documentFileStore.readDocumentLease(documentId);
    } catch (cause) {
      throw new DocumentPublicationReadError({
        id: documentId,
        cause,
        message: `Could not read published document ${documentId}: ${describe(cause)}`,
      });
    }
  };

  const readPublishedDocumentPromise = async (id: DocumentId) => {
    const lease = await readPublishedDocumentLeasePromise(id);
    lease.stream.once("close", lease.release);
    lease.stream.once("error", lease.release);
    return lease.stream;
  };

  const inspectPublishedDocumentPromise = async (id: DocumentId) => {
    const documentId = validateDocumentId(id);
    if (metadataStore.getDocumentMetadata(documentId) === undefined) {
      throw new DocumentPublicationNotFoundError({
        id: documentId,
        message: `Document ${documentId} is not a committed publication.`,
      });
    }
    try {
      return await documentFileStore.inspectDocumentFormat(documentId);
    } catch (cause) {
      throw new DocumentPublicationReadError({
        id: documentId,
        cause,
        message: `Could not inspect published document ${documentId}: ${describe(cause)}`,
      });
    }
  };

  const readPublishedDocumentEntryLeasePromise = async (id: DocumentId, path: string) => {
    const documentId = validateDocumentId(id);
    if (metadataStore.getDocumentMetadata(documentId) === undefined) {
      throw new DocumentPublicationNotFoundError({
        id: documentId,
        message: `Document ${documentId} is not a committed publication.`,
      });
    }
    try {
      return await documentFileStore.readDocumentEntryLease(documentId, path);
    } catch (cause) {
      throw new DocumentPublicationReadError({
        id: documentId,
        cause,
        message: `Could not read published document ${documentId}: ${describe(cause)}`,
      });
    }
  };

  const readError = (id: DocumentId, cause: unknown) =>
    cause instanceof DocumentPublicationReadError ||
    cause instanceof DocumentPublicationNotFoundError
      ? cause
      : new DocumentPublicationReadError({
          id,
          cause,
          message: `Could not read published document ${id}: ${describe(cause)}`,
        });
  const readEffect = <Value>(id: DocumentId, operation: () => Promise<Value>) =>
    Effect.tryPromise({
      try: operation,
      catch: (cause) => readError(id, cause),
    });

  const readPublishedDocumentLease = (id: DocumentId) =>
    readEffect(id, () => readPublishedDocumentLeasePromise(id));
  const readPublishedDocument = (id: DocumentId) =>
    readEffect(id, () => readPublishedDocumentPromise(id));
  const inspectPublishedDocument = (id: DocumentId) =>
    readEffect(id, () => inspectPublishedDocumentPromise(id));
  const readPublishedDocumentEntryLease = (id: DocumentId, path: string) =>
    readEffect(id, () => readPublishedDocumentEntryLeasePromise(id, path));

  return {
    readPublishedDocument,
    readPublishedDocumentLease,
    inspectPublishedDocument,
    readPublishedDocumentEntryLease,
  };
};
