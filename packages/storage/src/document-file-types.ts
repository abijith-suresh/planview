import type { ReadStream, Stats } from "node:fs";
import type { BundleManifest } from "@planview/core";
import { Data } from "effect";

export type DocumentFileStoreOptions = {
  readonly documentsDir: string;
  readonly stagingDir: string;
  readonly randomBytes?: (size: number) => Uint8Array;
  /** Clock used for lock leases and startup recovery. */
  readonly now?: () => number;
  /** Private race-test seam; production callers should leave this unset. */
  readonly beforeFinalizationLockRecoveryClaim?: (lockPath: string) => Promise<void>;
  /** Private race-test seam for the hard-link identity check. */
  readonly beforeStagedCloneLink?: (sourcePath: string) => Promise<void>;
  /** Private race-test seam for identity-safe clone compensation. */
  readonly beforeStagedCloneCleanup?: (clonedPath: string) => Promise<void>;
  /** Private race-test seam before the staged source is copied. */
  readonly beforeStagedSourceCopy?: (stagedPath: string) => Promise<void>;
  /** Private race-test seam immediately after the staged source is copied. */
  readonly afterStagedSourceCopy?: (sourcePath: string) => Promise<void>;
  /** Private race-test seam for identity-safe source cleanup. */
  readonly beforeStagedSourceCleanup?: (stagedPath: string) => Promise<void>;
  /** Private race-test seam immediately before the target hard link. */
  readonly beforeFinalizationTargetLink?: (targetPath: string) => Promise<void>;
  /** Private fault seam before target identity inspection. */
  readonly beforeFinalizationTargetInspection?: (targetPath: string) => Promise<void>;
  /** Private fault seam for target residual classification. */
  readonly beforeFinalizationTargetCleanup?: (targetPath: string) => Promise<void>;
  /** Private fault seam immediately before the post-publication staging sync. */
  readonly beforePostPublicationStagingDirectorySync?: () => Promise<void>;
  /** Private race-test seam for target compensation. */
  readonly beforeDocumentTargetDelete?: (targetPath: string) => Promise<void>;
  /** Private race-test seam immediately before a file-page scan begins. */
  readonly beforeDocumentFilePageScan?: (startedAt: number | undefined) => Promise<void>;
  /** Private deterministic seam for the file-page scan boundary. */
  readonly documentFileScanStartedAt?: () => number | undefined;
  /** Private deterministic seam for file-page scan observations. */
  readonly documentFileScanObservation?: (
    observation: DocumentFileObservation
  ) => DocumentFileObservation;
  /** Private test/benchmark seam for physical document-directory listings. */
  readonly onDocumentFileDirectoryEnumeration?: () => void;
  /** Private race-test seam immediately before scan-marker cleanup. */
  readonly beforeDocumentFileScanMarkerCleanup?: (markerPath: string) => Promise<void>;
};

declare const stagedDocumentFileHandleBrand: unique symbol;
declare const documentFileTargetCapabilityBrand: unique symbol;

/** A random capability naming one file in the private staging directory. */
export type StagedDocumentFileHandle = string & {
  readonly [stagedDocumentFileHandleBrand]: "StagedDocumentFileHandle";
};

/**
 * The identity returned by finalization and required for coordinator-owned
 * target compensation. It cannot be obtained by inspecting a pathname alone.
 */
export type DocumentFileTargetCapability = Readonly<{
  readonly id: string;
  readonly identity: Readonly<Pick<Stats, "dev" | "ino" | "birthtimeMs">>;
  readonly [documentFileTargetCapabilityBrand]: "DocumentFileTargetCapability";
}>;

/**
 * Runs the publication metadata handoff while the id-wide target lock is
 * still held. The target reader is valid only until the callback resolves.
 */
export type DocumentFileTargetCommit = (
  target: DocumentFileTargetCapability,
  readTarget: () => Promise<ReadStream>
) => Promise<void>;

export type DocumentFileResourceState = "absent" | "retained" | "unknown";
export type DocumentFileTargetRecoveryPolicy = "delete" | "retain";

export type DocumentFileFormat =
  | Readonly<{ readonly kind: "html" }>
  | Readonly<{ readonly kind: "bundle"; readonly manifest: BundleManifest }>;

export type DocumentFileIdentity = Readonly<Pick<Stats, "dev" | "ino" | "birthtimeMs">>;

export type DocumentFileObservation = Readonly<{
  readonly id: string;
  readonly size: number;
  readonly modifiedAt: number;
  /** The inode identity observed with this page entry. */
  readonly identity: DocumentFileIdentity;
}>;

export type DocumentFileScanWatermark = Readonly<{
  /** The maximum bytewise id examined by this pass. */
  readonly throughId: string;
  /**
   * A strict filesystem birth-time fence. Entries equal to the fence, or
   * whose birth time is unavailable, are deferred to a later pass.
   */
  readonly startedAt?: number;
}>;

export type DocumentFilePage = Readonly<{
  readonly files: readonly DocumentFileObservation[];
  readonly hasMore: boolean;
  readonly nextId?: string;
  readonly watermark?: DocumentFileScanWatermark;
}>;

/** A document stream whose active-read marker remains held until release. */
export type DocumentFileReadLease = Readonly<{
  readonly stream: ReadStream;
  readonly release: () => void;
}>;

export type DocumentFileReconciliationCursor = Readonly<{
  /** The directory watermark is fixed for every page in one pass. */
  readonly watermark: string;
  readonly afterName?: string;
}>;

export type DocumentFileReconciliationBudget = Readonly<{
  readonly maxItems: number;
  /** Shared cleanup deadline; false stops before starting another entry. */
  readonly shouldContinue?: () => boolean;
  readonly cursor?: DocumentFileReconciliationCursor;
}>;

export type DocumentFileReconciliationResult = Readonly<{
  readonly stagedFilesRemoved: number;
  readonly readReferencesRemoved: number;
  readonly finalizationLocksRemoved: number;
  readonly retainedEntries: number;
  readonly processedItems: number;
  readonly resumable: boolean;
  readonly cursor?: DocumentFileReconciliationCursor;
}>;

export class DocumentFileStorePathError extends Data.TaggedError("DocumentFileStorePathError")<{
  readonly path: string;
  readonly reason: string;
  readonly message: string;
}> {}

export class DocumentFileStoreOpenError extends Data.TaggedError("DocumentFileStoreOpenError")<{
  readonly path: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class DocumentFileStoreClosedError extends Data.TaggedError("DocumentFileStoreClosedError")<{
  readonly message: string;
}> {}

export class DocumentFileSourceError extends Data.TaggedError("DocumentFileSourceError")<{
  readonly path: string;
  readonly cause: unknown;
  readonly cleanupCause?: unknown;
  readonly message: string;
}> {}

export class DocumentFileNotRegularError extends Data.TaggedError("DocumentFileNotRegularError")<{
  readonly path: string;
  readonly message: string;
}> {}

export class InvalidStagedDocumentFileHandleError extends Data.TaggedError(
  "InvalidStagedDocumentFileHandleError"
)<{
  readonly value: unknown;
  readonly message: string;
}> {}

export class DocumentFileAlreadyExistsError extends Data.TaggedError(
  "DocumentFileAlreadyExistsError"
)<{
  readonly id: string;
  readonly message: string;
}> {}

/** A live peer owns the id-wide target lock; callers may safely retry another id. */
export class DocumentFileTargetBusyError extends Data.TaggedError("DocumentFileTargetBusyError")<{
  readonly id: string;
  readonly message: string;
}> {}

export class DocumentFileFinalizeError extends Data.TaggedError("DocumentFileFinalizeError")<{
  readonly id: string;
  readonly handle: string;
  /** Whether a linked target may still be retained when the failure escaped. */
  readonly targetCreated: boolean;
  /** Whether the target-commit callback was entered after durable publication. */
  readonly targetCommitAttempted: boolean;
  /** The identity capability for a target this finalizer linked, if retained or uncertain. */
  readonly targetCapability?: DocumentFileTargetCapability;
  /** Whether coordinator compensation may delete a retained target. */
  readonly targetRecoveryPolicy: DocumentFileTargetRecoveryPolicy;
  /** The best-known path state after any target compensation. */
  readonly targetState: DocumentFileResourceState;
  /** The state of the id-wide target lock used to serialize target cleanup. */
  readonly targetLockState: DocumentFileResourceState;
  /** Whether it is safe for the owning coordinator to try the staged handle. */
  readonly stagingMayBeDiscarded: boolean;
  readonly stagedFileState: DocumentFileResourceState;
  readonly finalizationLockState: DocumentFileResourceState;
  readonly cause: unknown;
  readonly cleanupCause?: unknown;
  readonly message: string;
}> {}

export class DocumentFileDiscardError extends Data.TaggedError("DocumentFileDiscardError")<{
  readonly handle: string;
  readonly stagedFileState: DocumentFileResourceState;
  readonly finalizationLockState: DocumentFileResourceState;
  readonly cause: unknown;
  readonly cleanupCause?: unknown;
  readonly message: string;
}> {}

export class DocumentFileCloneError extends Data.TaggedError("DocumentFileCloneError")<{
  readonly handle: string;
  readonly clonedHandle?: StagedDocumentFileHandle;
  readonly sourceFileState: DocumentFileResourceState;
  readonly clonedFileState: DocumentFileResourceState;
  readonly finalizationLockState: DocumentFileResourceState;
  readonly cause: unknown;
  readonly cleanupCause?: unknown;
  readonly message: string;
}> {}

export class DocumentFileReadError extends Data.TaggedError("DocumentFileReadError")<{
  readonly id: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class DocumentFileNotBundleError extends Data.TaggedError("DocumentFileNotBundleError")<{
  readonly id: string;
  readonly message: string;
}> {}

export class DocumentFileReadActiveError extends Data.TaggedError("DocumentFileReadActiveError")<{
  readonly id: string;
  readonly message: string;
}> {}

export class DocumentFileDeleteError extends Data.TaggedError("DocumentFileDeleteError")<{
  readonly id: string;
  readonly targetState: DocumentFileResourceState;
  readonly targetLockState: DocumentFileResourceState;
  readonly cause: unknown;
  readonly message: string;
}> {}

export interface DocumentFileStore {
  /** Requests closure and resolves after all already-started operations release their leases. */
  readonly close: () => Promise<void>;
  readonly stageSourceFile: (
    sourcePath: string,
    signal?: AbortSignal
  ) => Promise<StagedDocumentFileHandle>;
  readonly finalizeStagedFile: (
    handle: StagedDocumentFileHandle,
    id: string,
    targetCommit?: DocumentFileTargetCommit
  ) => Promise<DocumentFileTargetCapability>;
  readonly readDocument: (id: string) => Promise<ReadStream>;
  readonly readDocumentLease: (id: string) => Promise<DocumentFileReadLease>;
  readonly readDocumentFile: (id: string) => Promise<ReadStream>;
  readonly inspectDocumentFormat: (id: string) => Promise<DocumentFileFormat>;
  readonly readDocumentEntryLease: (id: string, path: string) => Promise<DocumentFileReadLease>;
  readonly deleteDocumentFile: (
    id: string,
    expectedTarget?: DocumentFileTargetCapability
  ) => Promise<boolean>;
  /** Runs the retention decision while the id-wide target lock is held. */
  readonly deleteDocumentFileIf: (
    id: string,
    shouldDelete: (targetExists: boolean) => boolean | Promise<boolean>,
    expectedIdentity?: DocumentFileIdentity
  ) => Promise<boolean>;
  readonly getDocumentFileObservation: (id: string) => Promise<DocumentFileObservation | undefined>;
  readonly listDocumentFiles: () => Promise<readonly DocumentFileObservation[]>;
  /** Returns a bounded id-ordered page without materializing file observations past the page. */
  readonly listDocumentFilesPage: (
    limit: number,
    afterId?: string,
    watermark?: DocumentFileScanWatermark
  ) => Promise<DocumentFilePage>;
  /** Reclaims only stale, provably-owned staging and lock entries. */
  readonly reconcileDocumentFiles: (
    budget?: DocumentFileReconciliationBudget
  ) => Promise<DocumentFileReconciliationResult>;
  /** Creates a second immutable staged handle without reopening source input. */
  readonly cloneStagedFile: (handle: StagedDocumentFileHandle) => Promise<StagedDocumentFileHandle>;
  /** Safely consumes a staged handle when a coordinator needs compensation. */
  readonly discardStagedFile: (handle: StagedDocumentFileHandle) => Promise<boolean>;
}
