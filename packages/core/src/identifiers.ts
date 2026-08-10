import { randomBytes as cryptoRandomBytes } from "node:crypto";

export const DOCUMENT_ID_LENGTH = 21;
export const DOCUMENT_ID_ALPHABET =
  "_-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

const documentIdPattern = new RegExp(`^[A-Za-z0-9_-]{${DOCUMENT_ID_LENGTH}}$`);

declare const documentIdBrand: unique symbol;

export type DocumentId = string & {
  readonly [documentIdBrand]: "DocumentId";
};

export type DocumentIdRandomBytes = (size: number) => Uint8Array;

export type DocumentIdGenerationOptions = {
  readonly randomBytes?: DocumentIdRandomBytes;
};

export class InvalidDocumentIdError extends Error {
  readonly _tag = "InvalidDocumentIdError" as const;
  readonly code = "INVALID_DOCUMENT_ID" as const;
  readonly value: unknown;

  constructor(value: unknown) {
    super(
      `Document id must be exactly ${DOCUMENT_ID_LENGTH} characters from the URL-safe NanoID alphabet.`
    );
    this.name = "InvalidDocumentIdError";
    this.value = value;
  }
}

export class DocumentIdGenerationError extends Error {
  readonly _tag = "DocumentIdGenerationError" as const;
  readonly code = "DOCUMENT_ID_GENERATION_FAILED" as const;
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super("Could not generate a document id from the configured random source.");
    this.name = "DocumentIdGenerationError";
    this.cause = cause;
  }
}

export const isValidDocumentId = (value: unknown): value is DocumentId =>
  typeof value === "string" && documentIdPattern.test(value);

export const validateDocumentId = (value: unknown) => {
  if (!isValidDocumentId(value)) {
    throw new InvalidDocumentIdError(value);
  }

  return value;
};

export const generateDocumentId = ({
  randomBytes = cryptoRandomBytes,
}: DocumentIdGenerationOptions = {}) => {
  let bytes: Uint8Array;
  try {
    bytes = randomBytes(DOCUMENT_ID_LENGTH);
  } catch (cause) {
    throw new DocumentIdGenerationError(cause);
  }

  if (!(bytes instanceof Uint8Array) || bytes.length < DOCUMENT_ID_LENGTH) {
    throw new DocumentIdGenerationError(
      new TypeError(`The random source must return at least ${DOCUMENT_ID_LENGTH} bytes.`)
    );
  }

  let value = "";
  for (let index = 0; index < DOCUMENT_ID_LENGTH; index += 1) {
    const byte = bytes[index];
    if (byte === undefined) {
      throw new DocumentIdGenerationError(
        new TypeError(`The random source did not provide byte ${index}.`)
      );
    }
    value += DOCUMENT_ID_ALPHABET[byte & 63];
  }

  return validateDocumentId(value);
};
