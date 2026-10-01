import { UTApi, UTFile } from "uploadthing/server";

export const uploadHtmlFile = async ({ file, customId }: { file: File; customId: string }) => {
  const token = process.env["UPLOADTHING_TOKEN"];
  if (!token) throw new Error("File storage is not configured yet.");

  const result = await new UTApi({ token }).uploadFiles(
    new UTFile([new Uint8Array(await file.arrayBuffer())], file.name, {
      type: "text/html",
      customId,
    }),
    { acl: "public-read", contentDisposition: "inline" }
  );

  if (result.error || !result.data) {
    throw new Error(result.error?.message ?? "The HTML file could not be stored.");
  }
};
