import { V1_RETENTION_DAYS } from "@planview/core";
import { Data } from "effect";
import {
  DOCUMENT_FILE_RECOVERY_GRACE_MILLISECONDS,
  type DocumentFileObservation,
  type DocumentFileReconciliationResult,
  type DocumentFileStore,
} from "./document-files.js";
import type { DocumentMetadata, MetadataStore } from "./index.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
/**
 * A just-finalized target can briefly exist before its metadata transaction.
 * Keep fresh uncommitted targets for one publication lock lease plus grace so
 * a crash-safe reconciliation pass cannot delete a live publisher's target.
 */
export const V1_ORPHAN_RECONCILIATION_GRACE_MILLISECONDS =
  DOCUMENT_FILE_RECOVERY_GRACE_MILLISECONDS;

export type DocumentCleanupFailure = Readonly<{
  readonly phase: "staging" | "metadata" | "document-file";
  readonly id?: string;
  readonly cause: unknown;
  readonly message: string;
}>;

export type DocumentCleanupResult = Readonly<{
  readonly now: number;
  readonly cutoff: number;
  readonly removedDocuments: number;
  readonly removedDocumentFiles: number;
  readonly removedMetadataRows: number;
  readonly removedStagedFiles: number;
  readonly removedReadReferences: number;
  readonly removedFinalizationLocks: number;
  readonly reclaimedBytes: number;
  readonly retainedEntries: number;
  readonly failures: readonly DocumentCleanupFailure[];
}>;

export type DocumentCleanupCoordinatorOptions = Readonly<{
  readonly documentFileStore: DocumentFileStore;
  readonly metadataStore: MetadataStore;
  readonly now?: () => number;
  readonly retentionDays?: number;
  /** Private deterministic fault seam for cleanup tests. */
  readonly beforeDocumentCleanup?: (id: string) => Promise<void>;
  /** Private deterministic fault seam for reconciliation tests. */
  readonly beforeReconciliation?: () => Promise<void>;
}>;

export class DocumentCleanupError extends Data.TaggedError("DocumentCleanupError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const validNow = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("The cleanup clock must return a non-negative safe integer.");
  }
  return value;
};

const validRetentionDays = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("The cleanup retention period must be a non-negative safe integer.");
  }
  return value;
};

const failureFor = (phase: DocumentCleanupFailure["phase"], cause: unknown, id?: string) => ({
  phase,
  ...(id === undefined ? {} : { id }),
  cause,
  message: describe(cause),
});

const bytesFor = (file: DocumentFileObservation | undefined) =>
  file === undefined ? 0 : file.size;

const isOldEnoughOrphan = (file: DocumentFileObservation, now: number) =>
  Number.isFinite(file.modifiedAt) &&
  file.modifiedAt <= now - V1_ORPHAN_RECONCILIATION_GRACE_MILLISECONDS;

export const createDocumentCleanupCoordinator = (options: DocumentCleanupCoordinatorOptions) => {
  const {
    documentFileStore,
    metadataStore,
    now = Date.now,
    retentionDays = V1_RETENTION_DAYS,
    beforeDocumentCleanup,
    beforeReconciliation,
  } = options;
  const retention = validRetentionDays(retentionDays);
  let running: Promise<DocumentCleanupResult> | undefined;

  const run = async () => {
    const currentTime = validNow(now());
    const cutoff = Math.max(0, currentTime - retention * DAY_MS);
    const failures: DocumentCleanupFailure[] = [];
    let removedDocuments = 0;
    let removedDocumentFiles = 0;
    let removedMetadataRows = 0;
    let reclaimedBytes = 0;
    let removedStagedFiles = 0;
    let removedReadReferences = 0;
    let removedFinalizationLocks = 0;
    let retainedEntries = 0;

    await beforeReconciliation?.();
    let staging: DocumentFileReconciliationResult;
    try {
      staging = await documentFileStore.reconcileDocumentFiles();
      removedStagedFiles += staging.stagedFilesRemoved;
      removedReadReferences += staging.readReferencesRemoved;
      removedFinalizationLocks += staging.finalizationLocksRemoved;
      retainedEntries += staging.retainedEntries;
    } catch (cause) {
      failures.push(failureFor("staging", cause));
      retainedEntries += 1;
    }

    let metadata: readonly DocumentMetadata[];
    let files: readonly DocumentFileObservation[];
    try {
      metadata = metadataStore.listDocumentMetadata();
      files = await documentFileStore.listDocumentFiles();
    } catch (cause) {
      throw new DocumentCleanupError({
        cause,
        message: `Could not inspect Planview cleanup state: ${describe(cause)}`,
      });
    }

    const fileById = new Map(files.map((file) => [file.id, file]));
    const metadataById = new Map(metadata.map((row) => [row.id, row]));
    // Do not reinterpret a file under an id whose metadata cleanup was already
    // attempted in this pass. If a filesystem boundary was ambiguous, the next
    // pass must re-observe it before any orphan policy can act.
    const protectedFileIds = new Set<string>();

    for (const row of metadata) {
      protectedFileIds.add(row.id);
      if (row.lastAccessedAt >= cutoff) {
        continue;
      }
      let deletedMetadata: DocumentMetadata | undefined;
      try {
        await beforeDocumentCleanup?.(row.id);
        const removedFile = await documentFileStore.deleteDocumentFileIf(row.id, (targetExists) => {
          deletedMetadata = metadataStore.deleteDocumentIfLastAccessedBefore(row.id, cutoff);
          return deletedMetadata !== undefined && targetExists;
        });
        if (deletedMetadata !== undefined) {
          removedDocuments += 1;
          removedMetadataRows += 1;
          if (removedFile) {
            removedDocumentFiles += 1;
            // The filesystem observation is authoritative for reclaimed bytes;
            // metadata can be stale or mismatched during reconciliation.
            reclaimedBytes += bytesFor(fileById.get(row.id));
          }
        }
      } catch (cause) {
        failures.push(failureFor("document-file", cause, row.id));
        retainedEntries += 1;
      }
    }

    // Re-read the database after conditional stale deletes. A concurrent access
    // update wins the SQLite transaction and therefore removes the row from the
    // retention candidate set without the cleaner guessing at ownership.
    try {
      metadata = metadataStore.listDocumentMetadata();
      files = await documentFileStore.listDocumentFiles();
    } catch (cause) {
      throw new DocumentCleanupError({
        cause,
        message: `Could not recheck Planview cleanup state: ${describe(cause)}`,
      });
    }
    fileById.clear();
    for (const file of files) {
      fileById.set(file.id, file);
    }
    metadataById.clear();
    for (const row of metadata) {
      metadataById.set(row.id, row);
    }

    // A committed row without its immutable file cannot ever be served. Remove
    // only the exact row observed by reconciliation; a newly inserted row is
    // never compensated by matching guessed fields.
    for (const row of metadata) {
      if (fileById.has(row.id)) {
        continue;
      }
      let removed = false;
      try {
        await documentFileStore.deleteDocumentFileIf(row.id, (targetExists) => {
          if (targetExists) {
            return false;
          }
          removed = metadataStore.deleteDocumentIfMatches(row);
          return false;
        });
        if (removed) {
          removedMetadataRows += 1;
        }
      } catch (cause) {
        failures.push(failureFor("metadata", cause, row.id));
        retainedEntries += 1;
      }
    }

    // A size mismatch means the metadata no longer describes the immutable
    // bytes. Make the pair invisible first, then remove the physical target
    // while its id-wide lock is held. The next startup can safely retry an
    // ambiguous filesystem failure.
    for (const file of files) {
      const row = metadataById.get(file.id);
      if (row === undefined || row.size === file.size) {
        continue;
      }
      let removed = false;
      try {
        await documentFileStore.deleteDocumentFileIf(file.id, (targetExists) => {
          if (!targetExists) {
            return false;
          }
          removed = metadataStore.deleteDocumentIfMatches(row);
          return removed;
        });
        if (removed) {
          removedMetadataRows += 1;
          removedDocumentFiles += 1;
          reclaimedBytes += bytesFor(file);
        }
      } catch (cause) {
        failures.push(failureFor("document-file", cause, file.id));
        retainedEntries += 1;
      }
    }

    // Physical files without committed metadata are never published by the
    // metadata-gated reader. Delete only after the row absence is re-proven
    // while the target lock is held, so a publication cannot be removed between
    // the scan and its metadata commit.
    for (const file of files) {
      if (
        protectedFileIds.has(file.id) ||
        metadataById.has(file.id) ||
        !isOldEnoughOrphan(file, currentTime)
      ) {
        if (!metadataById.has(file.id)) {
          retainedEntries += 1;
        }
        continue;
      }
      let removed = false;
      try {
        removed = await documentFileStore.deleteDocumentFileIf(file.id, (targetExists) => {
          if (!targetExists) {
            return false;
          }
          if (metadataStore.getDocumentMetadata(file.id) !== undefined) {
            return false;
          }
          return true;
        });
        if (removed) {
          removedDocumentFiles += 1;
          reclaimedBytes += file.size;
        }
      } catch (cause) {
        failures.push(failureFor("document-file", cause, file.id));
        retainedEntries += 1;
      }
    }

    return Object.freeze({
      now: currentTime,
      cutoff,
      removedDocuments,
      removedDocumentFiles,
      removedMetadataRows,
      removedStagedFiles,
      removedReadReferences,
      removedFinalizationLocks,
      reclaimedBytes,
      retainedEntries,
      failures: Object.freeze(failures),
    });
  };

  const clean = () => {
    if (running === undefined) {
      running = run().finally(() => {
        running = undefined;
      });
    }
    return running;
  };

  return { clean };
};

/** Short daemon-internal alias. */
export const createCleanupCoordinator = createDocumentCleanupCoordinator;
export const V1_RETENTION_MILLISECONDS = V1_RETENTION_DAYS * DAY_MS;
