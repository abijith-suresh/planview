import {
  reportDocumentUploadCompensationFailure,
  type DocumentUploadCompensationReporter,
} from "./document-upload-compensation.ts";

export type DocumentCollectionMetadata = {
  title: string;
  storageProvider: "uploadthing";
  storageKey: string;
  contentType: "text/html";
  sizeBytes: number;
};

export type DocumentCollectionHandlerDependencies<Client> = {
  getAuthedClient(request: Request): Promise<{
    client: Client;
    token: string | null | undefined;
  }>;
  getCurrentUser(client: Client): Promise<{ subject: string } | null | undefined>;
  listDocuments(client: Client): Promise<unknown>;
  isStorageConfigured(): boolean;
  createMetadata(client: Client, input: DocumentCollectionMetadata): Promise<string>;
  deleteStorageObject(key: string): Promise<void>;
  reportCompensationFailure?: DocumentUploadCompensationReporter;
  missingServerConfigurationResponse(): Response;
  errorResponse(error: unknown): Response;
};

type CreateDocumentBody = {
  title?: unknown;
  storageProvider?: unknown;
  uploadOwnerId?: unknown;
  uploadCustomId?: unknown;
  contentType?: unknown;
  sizeBytes?: unknown;
};

const MAX_TITLE_LENGTH = 200;
const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024;
const STORAGE_KEY_PREFIX = "uploadthing-custom-id:";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorResponse = <Client>(
  dependencies: DocumentCollectionHandlerDependencies<Client>,
  error: unknown
) =>
  error instanceof Error && error.message === "Convex is not configured"
    ? dependencies.missingServerConfigurationResponse()
    : dependencies.errorResponse(error);

export function createDocumentCollectionHandlers<Client>(
  dependencies: DocumentCollectionHandlerDependencies<Client>
) {
  const GET = async ({ request }: { request: Request }) => {
    try {
      const { client, token } = await dependencies.getAuthedClient(request);

      if (!token) {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }

      return Response.json(await dependencies.listDocuments(client));
    } catch (error) {
      return errorResponse(dependencies, error);
    }
  };

  const POST = async ({ request }: { request: Request }) => {
    let body: unknown;

    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Request body must be valid JSON" }, { status: 400 });
    }

    const record = isRecord(body) ? (body as CreateDocumentBody) : {};
    const title = typeof record.title === "string" ? record.title.trim() : "";
    const storageProvider =
      typeof record.storageProvider === "string" ? record.storageProvider : "";
    const uploadOwnerId = typeof record.uploadOwnerId === "string" ? record.uploadOwnerId : "";
    const uploadCustomId = typeof record.uploadCustomId === "string" ? record.uploadCustomId : "";
    const contentType = typeof record.contentType === "string" ? record.contentType : "";
    const sizeBytes = typeof record.sizeBytes === "number" ? record.sizeBytes : NaN;

    if (
      title.length === 0 ||
      title.length > MAX_TITLE_LENGTH ||
      storageProvider !== "uploadthing" ||
      uploadOwnerId.length === 0 ||
      uploadCustomId.length === 0 ||
      contentType !== "text/html" ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 0 ||
      sizeBytes > MAX_FILE_SIZE_BYTES
    ) {
      return Response.json(
        { error: "A title, uploaded HTML file, content type, and size are required" },
        { status: 400 }
      );
    }

    try {
      const { client, token } = await dependencies.getAuthedClient(request);

      if (!token) {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }

      const identity = await dependencies.getCurrentUser(client);

      if (!identity) {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }

      if (
        uploadOwnerId !== identity.subject ||
        !uploadCustomId.startsWith(`${identity.subject}:`)
      ) {
        return Response.json(
          { error: "The uploaded file does not belong to this account" },
          { status: 403 }
        );
      }

      if (!dependencies.isStorageConfigured()) {
        return Response.json(
          {
            error: "File storage is not configured yet.",
            code: "STORAGE_NOT_CONFIGURED",
          },
          { status: 503 }
        );
      }

      const storageKey = `${STORAGE_KEY_PREFIX}${uploadCustomId}`;
      let id: string;

      try {
        id = await dependencies.createMetadata(client, {
          title,
          storageProvider,
          storageKey,
          contentType: "text/html",
          sizeBytes,
        });
      } catch (error) {
        // Keep metadata failures from leaving a completed UploadThing object behind.
        try {
          await dependencies.deleteStorageObject(storageKey);
        } catch (cleanupCause) {
          await reportDocumentUploadCompensationFailure(dependencies.reportCompensationFailure, {
            objectKey: storageKey,
            metadataCause: error,
            cleanupCause,
          });
        }
        throw error;
      }

      return Response.json({ id }, { status: 201 });
    } catch (error) {
      return errorResponse(dependencies, error);
    }
  };

  return { GET, POST };
}
