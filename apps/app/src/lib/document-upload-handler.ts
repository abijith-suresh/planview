export type DocumentUploadMetadata = {
  title: string;
  storageProvider: "uploadthing";
  storageKey: string;
  contentType: "text/html";
  sizeBytes: number;
};

export type DocumentUploadHandlerDependencies<Client> = {
  getAuthedClient(request: Request): Promise<{ client: Client; token: string | null | undefined }>;
  getCurrentUser(client: Client): Promise<{ subject: string } | null | undefined>;
  isStorageConfigured(): boolean;
  uploadFile(input: { file: File; customId: string }): Promise<void>;
  createMetadata(client: Client, input: DocumentUploadMetadata): Promise<string>;
  deleteStorageObject(key: string): Promise<void>;
  createUploadId(): string;
  missingServerConfigurationResponse(): Response;
  errorResponse(error: unknown): Response;
};

const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_SIZE_BYTES = MAX_FILE_SIZE_BYTES + 64 * 1024;
const STORAGE_KEY_PREFIX = "uploadthing-custom-id:";

export function createDocumentUploadHandler<Client>(
  dependencies: DocumentUploadHandlerDependencies<Client>
) {
  return async ({ request }: { request: Request }) => {
    const contentLength = Number(request.headers.get("content-length"));

    if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
      return Response.json(
        { error: "A bounded Content-Length header is required" },
        { status: 411 }
      );
    }
    if (contentLength > MAX_REQUEST_SIZE_BYTES) {
      return Response.json(
        { error: "The upload request exceeds the 8 MiB limit" },
        { status: 413 }
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
      if (!dependencies.isStorageConfigured()) {
        return Response.json(
          { error: "File storage is not configured yet.", code: "STORAGE_NOT_CONFIGURED" },
          { status: 503 }
        );
      }

      let formData: FormData;
      try {
        formData = await request.formData();
      } catch {
        return Response.json({ error: "The upload form could not be read" }, { status: 400 });
      }

      const files = formData.getAll("file");
      const file = files[0];
      const titleField = formData.get("title");
      const title = typeof titleField === "string" ? titleField.trim() : "";

      if (
        files.length !== 1 ||
        typeof File === "undefined" ||
        !(file instanceof File) ||
        !file.name.toLowerCase().endsWith(".html") ||
        file.type !== "text/html" ||
        file.size > MAX_FILE_SIZE_BYTES ||
        title.length === 0 ||
        title.length > 200
      ) {
        return Response.json(
          { error: "Upload one .html file up to 8 MiB with a title of 1 to 200 characters" },
          { status: 400 }
        );
      }

      const customId = `${identity.subject}:${dependencies.createUploadId()}`;
      const storageKey = `${STORAGE_KEY_PREFIX}${customId}`;
      await dependencies.uploadFile({ file, customId });

      let id: string;
      try {
        id = await dependencies.createMetadata(client, {
          title,
          storageProvider: "uploadthing",
          storageKey,
          contentType: "text/html",
          sizeBytes: file.size,
        });
      } catch (error) {
        await dependencies.deleteStorageObject(storageKey).catch(() => undefined);
        throw error;
      }

      return Response.json({ id }, { status: 201 });
    } catch (error) {
      if (error instanceof Error && error.message === "Convex is not configured") {
        return dependencies.missingServerConfigurationResponse();
      }

      return dependencies.errorResponse(error);
    }
  };
}
