import { V1_MAX_HTML_SIZE_BYTES } from "./policy.js";

export const SUPPORTED_SOURCE_EXTENSIONS = Object.freeze([".html", ".htm"] as const);

export type SupportedSourceExtension = (typeof SUPPORTED_SOURCE_EXTENSIONS)[number];

export class UnsupportedSourceExtensionError extends Error {
  readonly _tag = "UnsupportedSourceExtensionError" as const;
  readonly code = "UNSUPPORTED_SOURCE_EXTENSION" as const;
  readonly path: unknown;
  readonly extension: string;

  constructor(path: unknown, extension: string) {
    super(
      `Unsupported source file extension${extension === "" ? "" : ` ${JSON.stringify(extension)}`}; only .html and .htm files are supported.`
    );
    this.name = "UnsupportedSourceExtensionError";
    this.path = path;
    this.extension = extension;
  }
}

export class InvalidSourceFileSizeError extends Error {
  readonly _tag = "InvalidSourceFileSizeError" as const;
  readonly code = "INVALID_SOURCE_FILE_SIZE" as const;
  readonly sizeBytes: unknown;

  constructor(sizeBytes: unknown) {
    super("Source file size must be a non-negative safe integer number of bytes.");
    this.name = "InvalidSourceFileSizeError";
    this.sizeBytes = sizeBytes;
  }
}

export class SourceFileTooLargeError extends Error {
  readonly _tag = "SourceFileTooLargeError" as const;
  readonly code = "SOURCE_FILE_TOO_LARGE" as const;
  readonly sizeBytes: number;
  readonly maxSizeBytes = V1_MAX_HTML_SIZE_BYTES;

  constructor(sizeBytes: number) {
    super(`Source file size must not exceed ${V1_MAX_HTML_SIZE_BYTES} bytes (10 MiB).`);
    this.name = "SourceFileTooLargeError";
    this.sizeBytes = sizeBytes;
  }
}

const sourceFileName = (path: unknown) => {
  if (typeof path !== "string") {
    return undefined;
  }

  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return path.slice(separator + 1);
};

const isSupportedSourceExtension = (extension: string): extension is SupportedSourceExtension =>
  SUPPORTED_SOURCE_EXTENSIONS.some((supportedExtension) => supportedExtension === extension);

export const validateSourceFileExtension = (path: unknown) => {
  const fileName = sourceFileName(path);
  if (fileName === undefined || fileName.length === 0) {
    throw new UnsupportedSourceExtensionError(path, "");
  }

  const dot = fileName.lastIndexOf(".");
  const extension = dot > 0 ? fileName.slice(dot).toLowerCase() : "";
  if (!isSupportedSourceExtension(extension)) {
    throw new UnsupportedSourceExtensionError(path, extension);
  }

  return extension;
};

export const validateSourceFileSize = (sizeBytes: unknown) => {
  if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new InvalidSourceFileSizeError(sizeBytes);
  }

  if (sizeBytes > V1_MAX_HTML_SIZE_BYTES) {
    throw new SourceFileTooLargeError(sizeBytes);
  }

  return sizeBytes;
};

export const validateSourceFile = (path: unknown, sizeBytes: unknown) => {
  const extension = validateSourceFileExtension(path);
  validateSourceFileSize(sizeBytes);
  return extension;
};
