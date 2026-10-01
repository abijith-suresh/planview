import { ConvexError } from "convex/values";

import {
  reportDocumentUploadCompensationFailure,
  type DocumentUploadCompensationReporter,
} from "./document-upload-compensation.ts";

export type DocumentUploadMetadata = {
  title: string;
  storageProvider: "uploadthing";
  storageKey: string;
  contentType: "text/html" | "application/vnd.planview.bundle";
  sizeBytes: number;
};

export async function uploadReservedDocument(input: {
  metadata: DocumentUploadMetadata;
  file: File;
  customId: string;
  reserve(): Promise<{ id: string | null; uploadDeadlineAt: number }>;
  upload(options: { file: File; customId: string; deadlineAt: number }): Promise<void>;
  commit(): Promise<string>;
  abandon(uploadConfirmed: boolean): Promise<string | null>;
  reportCompensationFailure?: DocumentUploadCompensationReporter;
}) {
  // Admission must succeed before the provider receives any bytes. The same
  // reservation is exchanged for metadata in a single Convex transaction.
  const reservation = await input.reserve();
  if (reservation.id) return reservation.id;
  let uploadConfirmed = false;
  try {
    await input.upload({
      file: input.file,
      customId: input.customId,
      deadlineAt: reservation.uploadDeadlineAt,
    });
    uploadConfirmed = true;
    return await input.commit();
  } catch (metadataCause) {
    try {
      // Do not delete directly after an ambiguous commit response. The backend
      // returns a committed document or fences the reservation for cleanup.
      const committedId = await input.abandon(uploadConfirmed);
      if (committedId) return committedId;
    } catch (cleanupCause) {
      await reportDocumentUploadCompensationFailure(input.reportCompensationFailure, {
        objectKey: input.metadata.storageKey,
        metadataCause,
        cleanupCause,
      });
    }
    throw metadataCause;
  }
}

export function storageQuotaErrorResponse(error: unknown) {
  if (
    !(error instanceof ConvexError) ||
    !error.data ||
    typeof error.data !== "object" ||
    Array.isArray(error.data) ||
    error.data.code !== "STORAGE_QUOTA_EXCEEDED"
  )
    return null;
  return Response.json({ ...error.data, error: error.data.message }, { status: 409 });
}
