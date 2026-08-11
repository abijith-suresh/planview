import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Data, Effect } from "effect";

export {
  DocumentFileAlreadyExistsError,
  DocumentFileCloneError,
  DocumentFileDeleteError,
  DocumentFileDiscardError,
  DocumentFileFinalizeError,
  type DocumentFileTargetCapability,
  type DocumentFileTargetRecoveryPolicy,
  DocumentFileNotRegularError,
  DocumentFileReadError,
  type DocumentFileResourceState,
  DocumentFileSourceError,
  type DocumentFileStore,
  DocumentFileStoreClosedError,
  DocumentFileStoreOpenError,
  type DocumentFileStoreOptions,
  DocumentFileStorePathError,
  DocumentFileTargetBusyError,
  InvalidStagedDocumentFileHandleError,
  openDocumentFileStore,
  type StagedDocumentFileHandle,
} from "./document-files.js";
export {
  createDocumentPublicationCoordinator,
  createMetadataGatedDocumentReader,
  createPublicationCoordinator,
  type DocumentPublicationCoordinator,
  type DocumentPublicationCoordinatorOptions,
  DocumentPublicationError,
  DocumentPublicationNotFoundError,
  type DocumentPublicationOrphanState,
  DocumentPublicationReadError,
  type DocumentPublicationRecovery,
  type DocumentPublicationResource,
  type DocumentPublicationResourceState,
  type DocumentPublicationResult,
  DocumentPublicationRetryLimitError,
  type MetadataGatedDocumentReader,
  type MetadataGatedDocumentReaderOptions,
} from "./publication.js";

export type DocumentMetadata = {
  readonly id: string;
  readonly createdAt: number;
  readonly lastAccessedAt: number;
  readonly size: number;
};

export type DocumentAggregate = {
  readonly count: number;
  readonly size: number;
};

export class StoragePathError extends Data.TaggedError("StoragePathError")<{
  readonly path: string;
  readonly reason: string;
  readonly message: string;
}> {}

export class StorageOpenError extends Data.TaggedError("StorageOpenError")<{
  readonly path: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class StorageMigrationError extends Data.TaggedError("StorageMigrationError")<{
  readonly path: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class StorageClosedError extends Data.TaggedError("StorageClosedError")<{
  readonly message: string;
}> {}

export class StorageInvariantError extends Data.TaggedError("StorageInvariantError")<{
  readonly field: string;
  readonly message: string;
}> {}

export interface MetadataStore {
  readonly close: () => void;
  readonly insertDocumentMetadata: (metadata: DocumentMetadata) => void;
  readonly getDocumentMetadata: (id: string) => DocumentMetadata | undefined;
  readonly recordDocumentAccess: (id: string, accessedAt?: number) => boolean;
  readonly getDocumentAggregate: () => DocumentAggregate;
  readonly deleteDocument: (id: string) => boolean;
}

const CURRENT_SCHEMA_VERSION = 1;
const MEMORY_DATABASE_PATH = ":memory:";
const DOCUMENT_COLUMNS = ["id", "createdAt", "lastAccessedAt", "size"] as const;
const DOCUMENT_SCHEMA = `
  CREATE TABLE documents (
    id TEXT PRIMARY KEY NOT NULL
      CHECK (typeof(id) = 'text' AND length(trim(id)) > 0),
    createdAt INTEGER NOT NULL
      CHECK (typeof(createdAt) = 'integer' AND createdAt >= 0),
    lastAccessedAt INTEGER NOT NULL
      CHECK (typeof(lastAccessedAt) = 'integer' AND lastAccessedAt >= createdAt),
    size INTEGER NOT NULL
      CHECK (typeof(size) = 'integer' AND size >= 0)
  ) STRICT
`;

const isStorageError = (error: unknown) =>
  error instanceof StoragePathError ||
  error instanceof StorageOpenError ||
  error instanceof StorageMigrationError;

const validateDatabasePath = (path: string) => {
  if (typeof path !== "string" || path.length === 0) {
    throw new StoragePathError({
      path,
      reason: "The SQLite database path must be a non-empty string.",
      message:
        "Could not open SQLite metadata storage: the database path must be a non-empty string.",
    });
  }

  if (path !== MEMORY_DATABASE_PATH && !isAbsolute(path)) {
    throw new StoragePathError({
      path,
      reason: "The SQLite database path must be absolute.",
      message: `Could not open SQLite metadata storage at ${path}: the database path must be absolute.`,
    });
  }
};

const readInteger = (value: unknown, field: string) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new StorageInvariantError({
      field,
      message: `SQLite returned a non-safe integer for ${field}.`,
    });
  }

  return value;
};

const readText = (value: unknown, field: string) => {
  if (typeof value !== "string") {
    throw new StorageInvariantError({
      field,
      message: `SQLite returned non-text data for ${field}.`,
    });
  }

  return value;
};

const validateId = (id: unknown) => {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new StorageInvariantError({
      field: "id",
      message: "Document id must be a non-empty string.",
    });
  }

  return id;
};

const validateNonNegativeInteger = (value: unknown, field: string) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new StorageInvariantError({
      field,
      message: `${field} must be a non-negative safe integer epoch value.`,
    });
  }

  return value;
};

const validateMetadata = (metadata: DocumentMetadata) => {
  if (metadata === null || typeof metadata !== "object") {
    throw new StorageInvariantError({
      field: "metadata",
      message: "Document metadata must be an object.",
    });
  }

  const normalized = {
    id: validateId(metadata.id),
    createdAt: validateNonNegativeInteger(metadata.createdAt, "createdAt"),
    lastAccessedAt: validateNonNegativeInteger(metadata.lastAccessedAt, "lastAccessedAt"),
    size: validateNonNegativeInteger(metadata.size, "size"),
  };

  if (normalized.lastAccessedAt < normalized.createdAt) {
    throw new StorageInvariantError({
      field: "lastAccessedAt",
      message: "lastAccessedAt must not be earlier than createdAt.",
    });
  }

  return normalized;
};

const rowValue = (row: Record<string, unknown>, key: string) => row[key];

const documentFromRow = (row: Record<string, unknown>) => ({
  id: readText(rowValue(row, "id"), "id"),
  createdAt: readInteger(rowValue(row, "createdAt"), "createdAt"),
  lastAccessedAt: readInteger(rowValue(row, "lastAccessedAt"), "lastAccessedAt"),
  size: readInteger(rowValue(row, "size"), "size"),
});

const inTransaction = <Value>(database: DatabaseSync, operation: () => Value) => {
  database.exec("BEGIN IMMEDIATE");
  try {
    const value = operation();
    database.exec("COMMIT");
    return value;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the operation error; SQLite will close or recover the transaction.
    }
    throw error;
  }
};

const normalizeSchemaSql = (sql: string) => sql.replace(/\s+/g, " ").trim().toLowerCase();

const EXPECTED_COLUMN_INFO = [
  { cid: 0, name: "id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
  { cid: 1, name: "createdAt", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
  {
    cid: 2,
    name: "lastAccessedAt",
    type: "INTEGER",
    notnull: 1,
    dflt_value: null,
    pk: 0,
  },
  { cid: 3, name: "size", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
] as const;

const validateV1Schema = (database: DatabaseSync) => {
  const unexpectedObject = database
    .prepare(
      "SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND NOT (type = 'table' AND name = 'documents')"
    )
    .get();
  if (unexpectedObject !== undefined) {
    throw new Error(
      `The v1 database contains an unexpected user schema object: ${rowValue(unexpectedObject, "type")} ${rowValue(unexpectedObject, "name")}.`
    );
  }

  const table = database
    .prepare("PRAGMA table_list")
    .all()
    .find(
      (row) =>
        rowValue(row, "schema") === "main" &&
        rowValue(row, "name") === "documents" &&
        rowValue(row, "type") === "table"
    );
  if (
    table === undefined ||
    rowValue(table, "ncol") !== DOCUMENT_COLUMNS.length ||
    rowValue(table, "wr") !== 0 ||
    rowValue(table, "strict") !== 1
  ) {
    throw new Error("The documents table is not a strict v1 table.");
  }

  const columns = database.prepare("PRAGMA table_info(documents)").all();
  if (
    columns.length !== EXPECTED_COLUMN_INFO.length ||
    columns.some((column, index) => {
      const expected = EXPECTED_COLUMN_INFO[index];
      return (
        expected === undefined ||
        rowValue(column, "cid") !== expected.cid ||
        rowValue(column, "name") !== expected.name ||
        rowValue(column, "type") !== expected.type ||
        rowValue(column, "notnull") !== expected.notnull ||
        rowValue(column, "dflt_value") !== expected.dflt_value ||
        rowValue(column, "pk") !== expected.pk
      );
    })
  ) {
    throw new Error("The documents columns do not match the supported v1 metadata schema.");
  }

  const schemaRow = database
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'documents' AND tbl_name = 'documents'"
    )
    .get();
  const schemaSql = schemaRow === undefined ? undefined : rowValue(schemaRow, "sql");
  if (
    typeof schemaSql !== "string" ||
    normalizeSchemaSql(schemaSql) !== normalizeSchemaSql(DOCUMENT_SCHEMA)
  ) {
    throw new Error("The documents constraints do not match the supported v1 metadata schema.");
  }
};

const migrate = (database: DatabaseSync) =>
  inTransaction(database, () => {
    const versionRow = database.prepare("PRAGMA user_version").get();
    const version = readInteger(
      versionRow === undefined ? undefined : rowValue(versionRow, "user_version"),
      "user_version"
    );

    if (version !== 0 && version !== CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${version} is not supported; expected 0 or ${CURRENT_SCHEMA_VERSION}.`
      );
    }

    if (version === 0) {
      database.exec(DOCUMENT_SCHEMA);
      database.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
    }

    validateV1Schema(database);
  });

const createStore = (database: DatabaseSync): MetadataStore => {
  let closed = false;

  const ensureOpen = () => {
    if (closed || !database.isOpen) {
      throw new StorageClosedError({ message: "SQLite metadata storage is closed." });
    }
  };

  const close = () => {
    if (!closed) {
      database.close();
      closed = true;
    }
  };

  const insertDocumentMetadata = (metadata: DocumentMetadata) => {
    ensureOpen();
    const normalized = validateMetadata(metadata);
    inTransaction(database, () => {
      database
        .prepare(
          `INSERT INTO documents (id, createdAt, lastAccessedAt, size)
           VALUES (:id, :createdAt, :lastAccessedAt, :size)`
        )
        .run({
          ":id": normalized.id,
          ":createdAt": normalized.createdAt,
          ":lastAccessedAt": normalized.lastAccessedAt,
          ":size": normalized.size,
        });
    });
  };

  const getDocumentMetadata = (id: string) => {
    ensureOpen();
    const row = database
      .prepare("SELECT id, createdAt, lastAccessedAt, size FROM documents WHERE id = :id")
      .get({ ":id": validateId(id) });
    return row === undefined ? undefined : documentFromRow(row);
  };

  const recordDocumentAccess = (id: string, accessedAt = Date.now()) => {
    ensureOpen();
    const documentId = validateId(id);
    const timestamp = validateNonNegativeInteger(accessedAt, "accessedAt");

    return inTransaction(database, () => {
      const result = database
        .prepare(
          `UPDATE documents
           SET lastAccessedAt = :accessedAt
           WHERE id = :id
             AND :accessedAt >= createdAt
             AND :accessedAt >= lastAccessedAt`
        )
        .run({ ":id": documentId, ":accessedAt": timestamp });

      if (result.changes > 0) {
        return true;
      }

      const document = database
        .prepare("SELECT createdAt, lastAccessedAt FROM documents WHERE id = :id")
        .get({ ":id": documentId });
      if (document === undefined) {
        return false;
      }

      const createdAt = readInteger(rowValue(document, "createdAt"), "createdAt");
      const lastAccessedAt = readInteger(rowValue(document, "lastAccessedAt"), "lastAccessedAt");
      throw new StorageInvariantError({
        field: "accessedAt",
        message:
          timestamp < createdAt
            ? "accessedAt must not be earlier than createdAt."
            : `accessedAt must not be earlier than lastAccessedAt (${lastAccessedAt}).`,
      });
    });
  };

  const getDocumentAggregate = () => {
    ensureOpen();
    const row = database
      .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS size FROM documents")
      .get();
    return {
      count: readInteger(row === undefined ? undefined : rowValue(row, "count"), "count"),
      size: readInteger(row === undefined ? undefined : rowValue(row, "size"), "size"),
    };
  };

  const deleteDocument = (id: string) => {
    ensureOpen();
    return inTransaction(database, () => {
      const result = database
        .prepare("DELETE FROM documents WHERE id = :id")
        .run({ ":id": validateId(id) });
      return result.changes > 0;
    });
  };

  return {
    close,
    insertDocumentMetadata,
    getDocumentMetadata,
    recordDocumentAccess,
    getDocumentAggregate,
    deleteDocument,
  };
};

export const openStorage = (databasePath: string) =>
  Effect.try({
    try: () => {
      validateDatabasePath(databasePath);

      let database: DatabaseSync;
      try {
        database = new DatabaseSync(databasePath, { timeout: 5_000 });
      } catch (cause) {
        throw new StorageOpenError({
          path: databasePath,
          cause,
          message: `Could not open SQLite metadata storage at ${databasePath}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        });
      }

      try {
        migrate(database);
        return createStore(database);
      } catch (cause) {
        try {
          database.close();
        } catch {
          // Preserve the migration diagnostic.
        }
        throw new StorageMigrationError({
          path: databasePath,
          cause,
          message: `Could not migrate SQLite metadata storage at ${databasePath}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        });
      }
    },
    catch: (cause) =>
      isStorageError(cause)
        ? cause
        : new StorageOpenError({
            path: databasePath,
            cause,
            message: `Could not open SQLite metadata storage at ${databasePath}: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          }),
  });

export { CURRENT_SCHEMA_VERSION };
