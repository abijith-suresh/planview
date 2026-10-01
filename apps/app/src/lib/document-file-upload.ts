import { UTApi, UTFile } from "uploadthing/server";

export const uploadHtmlFile = async ({
  file,
  customId,
  deadlineAt,
}: {
  file: File;
  customId: string;
  deadlineAt: number;
}) => {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new Error("The upload reservation expired. Try uploading again.");
  const signal = AbortSignal.timeout(remainingMs);
  const token = process.env["UPLOADTHING_TOKEN"];
  if (!token) throw new Error("File storage is not configured yet.");

  const result = await new UTApi({
    token,
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        signal:
          init && "signal" in init && init.signal instanceof AbortSignal
            ? AbortSignal.any([signal, init.signal])
            : signal,
      }),
  }).uploadFiles(
    new UTFile([new Uint8Array(await file.arrayBuffer())], file.name, {
      type: file.type,
      customId,
    }),
    { acl: "public-read", contentDisposition: "inline" }
  );

  if (result.error || !result.data) {
    throw new Error(result.error?.message ?? "The HTML file could not be stored.");
  }
};
