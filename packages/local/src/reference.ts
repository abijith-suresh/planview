import { isValidDocumentId, type DocumentId } from "@planview/core";

export type ParsedDocumentReference = Readonly<{
  readonly documentId: DocumentId;
  readonly port?: number;
}>;

const invalidReference = () =>
  new Error("Document reference must be a valid 21-character id or an exact local Planview URL.");

export const parseDocumentReferenceDetails = (
  reference: string,
  expectedPort?: number
): ParsedDocumentReference => {
  if (isValidDocumentId(reference)) {
    return { documentId: reference };
  }

  if (reference.trim() !== reference) {
    throw invalidReference();
  }

  let url: URL;
  try {
    url = new URL(reference);
  } catch {
    throw invalidReference();
  }
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.port === ""
  ) {
    throw invalidReference();
  }

  const port = Number(url.port);
  const candidate = url.pathname.slice(1);
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    (expectedPort !== undefined && port !== expectedPort) ||
    url.pathname !== `/${candidate}` ||
    !isValidDocumentId(candidate)
  ) {
    throw invalidReference();
  }

  return { documentId: candidate, port };
};

export const parseDocumentReference = (reference: string, expectedPort?: number): DocumentId =>
  parseDocumentReferenceDetails(reference, expectedPort).documentId;
