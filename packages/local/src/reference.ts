import { isValidDocumentId, type DocumentId } from "@planview/core";
import { DAEMON_PORT } from "@planview/daemon";

export const parseDocumentReference = (reference: string, port = DAEMON_PORT): DocumentId => {
  if (isValidDocumentId(reference)) {
    return reference;
  }

  const expectedPort = String(port);
  const prefixes = [`http://localhost:${expectedPort}/`, `http://127.0.0.1:${expectedPort}/`];
  const prefix = prefixes.find((candidate) => reference.startsWith(candidate));
  if (prefix === undefined || reference.length <= prefix.length) {
    throw new Error(
      "Document reference must be a valid 21-character id or an exact local Planview URL."
    );
  }

  const candidate = reference.slice(prefix.length);
  if (!isValidDocumentId(candidate)) {
    throw new Error(
      "Document reference must be a valid 21-character id or an exact local Planview URL."
    );
  }
  return candidate;
};
