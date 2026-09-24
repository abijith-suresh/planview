export type DocumentUploadCompensationFailure = {
  objectKey: string;
  metadataCause: unknown;
  cleanupCause: unknown;
};

export type DocumentUploadCompensationReporter = (
  failure: DocumentUploadCompensationFailure
) => void | Promise<void>;

function describeCause(cause: unknown) {
  if (cause instanceof Error) {
    return {
      name: cause.name,
      message: cause.message,
      ...(cause.stack === undefined ? {} : { stack: cause.stack }),
    };
  }

  try {
    const value = JSON.stringify(cause);
    return { value: value ?? String(cause) };
  } catch {
    return { value: String(cause) };
  }
}

export async function reportDocumentUploadCompensationFailure(
  reporter: DocumentUploadCompensationReporter | undefined,
  failure: DocumentUploadCompensationFailure
) {
  try {
    if (reporter) {
      await reporter(failure);
      return;
    }

    process.stderr.write(
      `${JSON.stringify({
        event: "document_upload_compensation_failed",
        objectKey: failure.objectKey,
        metadataCause: describeCause(failure.metadataCause),
        cleanupCause: describeCause(failure.cleanupCause),
      })}\n`
    );
  } catch {
    // Reporting must not replace the metadata failure returned to the caller.
  }
}
