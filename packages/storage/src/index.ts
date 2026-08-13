import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Data, Effect } from "effect";

export {
  createCleanupCoordinator,
  createDocumentCleanupCoordinator,
  type DocumentCleanupCoordinatorOptions,
  DocumentCleanupError,
  type DocumentCleanupFailure,
  type DocumentCleanupResult,
  V1_CLEANUP_ITEM_BUDGET,
  V1_CLEANUP_TIME_BUDGET_MILLISECONDS,
  V1_ORPHAN_RECONCILIATION_GRACE_MILLISECONDS,
  V1_RETENTION_MILLISECONDS,
} from "./cleanup.js";
export {
  DOCUMENT_FILE_RECOVERY_GRACE_MILLISECONDS,
  DocumentFileAlreadyExistsError,
  DocumentFileCloneError,
  DocumentFileDeleteError,
  DocumentFileDiscardError,
  DocumentFileFinalizeError,
  DocumentFileNotRegularError,
  type DocumentFileIdentity,
  type DocumentFileObservation,
  type DocumentFilePage,
  type DocumentFileReconciliationBudget,
  type DocumentFileScanWatermark,
  type DocumentFileReconciliationCursor,
  DocumentFileReadActiveError,
  DocumentFileReadError,
  type DocumentFileReadLease,
  type DocumentFileReconciliationResult,
  type DocumentFileResourceState,
  DocumentFileSourceError,
  type DocumentFileStore,
  DocumentFileStoreClosedError,
  DocumentFileStoreOpenError,
  type DocumentFileStoreOptions,
  DocumentFileStorePathError,
  DocumentFileTargetBusyError,
  type DocumentFileTargetCapability,
  type DocumentFileTargetRecoveryPolicy,
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

export type DocumentMetadataSnapshot = Readonly<
  DocumentMetadata & {
    /** Immutable token for conditional cleanup deletion. */
    readonly generation: string;
  }
>;

export type DocumentMetadataMatch = DocumentMetadataSnapshot;

export type DocumentMetadataAccessCursor = Readonly<{
  readonly lastAccessedAt: number;
  readonly id: string;
}>;

export type DocumentMetadataPage = Readonly<{
  readonly rows: readonly DocumentMetadataSnapshot[];
  readonly hasMore: boolean;
}>;

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
  readonly listDocumentMetadata: () => readonly DocumentMetadata[];
  /** The rowid high-water mark for a mutation-safe metadata pass. */
  readonly getDocumentMetadataScanWatermark: () => number;
  /** Returns a bounded, access-ordered page for retention cleanup. */
  readonly listDocumentMetadataCandidates: (
    cutoff: number,
    limit: number,
    after?: DocumentMetadataAccessCursor,
    watermark?: number
  ) => DocumentMetadataPage;
  /** Returns a bounded id-ordered page for reconciliation. */
  readonly listDocumentMetadataPage: (
    limit: number,
    afterId?: string,
    watermark?: number
  ) => DocumentMetadataPage;
  readonly recordDocumentAccess: (id: string, accessedAt?: number) => boolean;
  readonly getDocumentAggregate: () => DocumentAggregate;
  readonly deleteDocument: (id: string) => boolean;
  /** Deletes only if the row is still older than the supplied retention cutoff. */
  readonly deleteDocumentIfLastAccessedBefore: (
    candidate: string | DocumentMetadataSnapshot,
    cutoff: number
  ) => DocumentMetadata | undefined;
  /** Deletes only when every immutable field and generation still match. */
  readonly deleteDocumentIfMatches: (metadata: DocumentMetadataMatch) => boolean;
}

const CURRENT_SCHEMA_VERSION = 2;
const MEMORY_DATABASE_PATH = ":memory:";
const DOCUMENT_COLUMNS = ["id", "createdAt", "lastAccessedAt", "size"] as const;
const DOCUMENT_INDEX_NAME = "documents_last_accessed_at_idx";
const GENERATION_TABLE_NAME = "document_generations";
const DOCUMENT_INDEX_SCHEMA = `
  CREATE INDEX ${DOCUMENT_INDEX_NAME} ON documents (lastAccessedAt, id)
`;
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
const GENERATION_SCHEMA = `
  CREATE TABLE ${GENERATION_TABLE_NAME} (
    id TEXT PRIMARY KEY NOT NULL
      CHECK (typeof(id) = 'text' AND length(trim(id)) > 0),
    generation TEXT NOT NULL
      CHECK (typeof(generation) = 'text' AND length(generation) > 0)
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

const validatePageLimit = (value: unknown) => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value >= Number.MAX_SAFE_INTEGER
  ) {
    throw new StorageInvariantError({
      field: "limit",
      message: "limit must be a positive safe integer smaller than Number.MAX_SAFE_INTEGER.",
    });
  }

  return value;
};

const validateGeneration = (generation: unknown) => {
  if (typeof generation !== "string" || generation.length === 0) {
    throw new StorageInvariantError({
      field: "generation",
      message: "Document metadata generation must be a non-empty string.",
    });
  }

  return generation;
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

const documentSnapshotFromRow = (row: Record<string, unknown>) => ({
  ...documentFromRow(row),
  generation: validateGeneration(rowValue(row, "generation")),
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
  { cid: 2, name: "lastAccessedAt", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
  { cid: 3, name: "size", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
] as const;

const validateDocumentTable = (database: DatabaseSync, version: 1 | 2) => {
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
    throw new Error(`The documents table is not a strict v${version} table.`);
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
    throw new Error(
      `The documents columns do not match the supported v${version} metadata schema.`
    );
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
    throw new Error(
      `The documents constraints do not match the supported v${version} metadata schema.`
    );
  }
};

const validateIndex = (database: DatabaseSync, required: boolean, version: 1 | 2) => {
  const indexRow = database
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = :name AND tbl_name = 'documents'"
    )
    .get({ ":name": DOCUMENT_INDEX_NAME });
  const indexSql = indexRow === undefined ? undefined : rowValue(indexRow, "sql");
  if (
    (required && typeof indexSql !== "string") ||
    (indexSql !== undefined &&
      (typeof indexSql !== "string" ||
        normalizeSchemaSql(indexSql) !== normalizeSchemaSql(DOCUMENT_INDEX_SCHEMA)))
  ) {
    throw new Error(
      `The lastAccessedAt index does not match the supported v${version} metadata schema.`
    );
  }
};

const validateV1Schema = (database: DatabaseSync) => {
  const unexpectedObject = database
    .prepare(
      `SELECT type, name FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
         AND NOT (type = 'table' AND name = 'documents')
         AND NOT (type = 'index' AND name = '${DOCUMENT_INDEX_NAME}')`
    )
    .get();
  if (unexpectedObject !== undefined) {
    throw new Error(
      `The v1 database contains an unexpected user schema object: ${rowValue(unexpectedObject, "type")} ${rowValue(unexpectedObject, "name")}.`
    );
  }

  validateDocumentTable(database, 1);
  validateIndex(database, false, 1);
};

const validateV2Schema = (database: DatabaseSync) => {
  const unexpectedObject = database
    .prepare(
      `SELECT type, name FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
         AND NOT (type = 'table' AND name IN ('documents', '${GENERATION_TABLE_NAME}'))
         AND NOT (type = 'index' AND name = '${DOCUMENT_INDEX_NAME}')`
    )
    .get();
  if (unexpectedObject !== undefined) {
    throw new Error(
      `The v2 database contains an unexpected user schema object: ${rowValue(unexpectedObject, "type")} ${rowValue(unexpectedObject, "name")}.`
    );
  }
  validateDocumentTable(database, 2);
  validateIndex(database, true, 2);
  const generationTable = database
    .prepare("PRAGMA table_list")
    .all()
    .find(
      (row) =>
        rowValue(row, "schema") === "main" &&
        rowValue(row, "name") === GENERATION_TABLE_NAME &&
        rowValue(row, "type") === "table"
    );
  if (
    generationTable === undefined ||
    rowValue(generationTable, "ncol") !== 2 ||
    rowValue(generationTable, "wr") !== 0 ||
    rowValue(generationTable, "strict") !== 1
  ) {
    throw new Error("The document generations table is not a strict v2 table.");
  }
  const generationSchemaRow = database
    .prepare(
      `SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = '${GENERATION_TABLE_NAME}' AND tbl_name = '${GENERATION_TABLE_NAME}'`
    )
    .get();
  const generationSchemaSql =
    generationSchemaRow === undefined ? undefined : rowValue(generationSchemaRow, "sql");
  if (
    typeof generationSchemaSql !== "string" ||
    normalizeSchemaSql(generationSchemaSql) !== normalizeSchemaSql(GENERATION_SCHEMA)
  ) {
    throw new Error("The document generation constraints do not match the supported v2 schema.");
  }
};

const migrate = (database: DatabaseSync) =>
  inTransaction(database, () => {
    const versionRow = database.prepare("PRAGMA user_version").get();
    const version = readInteger(
      versionRow === undefined ? undefined : rowValue(versionRow, "user_version"),
      "user_version"
    );

    if (version !== 0 && version !== 1 && version !== CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${version} is not supported; expected 0, 1, or ${CURRENT_SCHEMA_VERSION}.`
      );
    }

    if (version === 0) {
      database.exec(DOCUMENT_SCHEMA);
      database.exec(GENERATION_SCHEMA);
    } else if (version === 1) {
      // Validate before changing a claimed legacy database. A malformed v1
      // file must remain untouched so operators can recover its original bytes.
      validateV1Schema(database);
      database.exec(GENERATION_SCHEMA);
      const rows = database.prepare("SELECT id FROM documents").all();
      const insertGeneration = database.prepare(
        `INSERT INTO ${GENERATION_TABLE_NAME} (id, generation) VALUES (:id, :generation)`
      );
      for (const row of rows) {
        insertGeneration.run({
          ":id": readText(rowValue(row, "id"), "id"),
          ":generation": randomUUID(),
        });
      }
    }

    database.exec(
      `CREATE INDEX IF NOT EXISTS ${DOCUMENT_INDEX_NAME} ON documents (lastAccessedAt, id)`
    );
    database.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
    validateV2Schema(database);
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
      database
        .prepare(
          `INSERT INTO ${GENERATION_TABLE_NAME} (id, generation)
           VALUES (:id, :generation)
           ON CONFLICT(id) DO UPDATE SET generation = excluded.generation`
        )
        .run({ ":id": normalized.id, ":generation": randomUUID() });
    });
  };

  const getDocumentMetadata = (id: string) => {
    ensureOpen();
    const row = database
      .prepare("SELECT id, createdAt, lastAccessedAt, size FROM documents WHERE id = :id")
      .get({ ":id": validateId(id) });
    return row === undefined ? undefined : documentFromRow(row);
  };

  const listDocumentMetadata = () => {
    ensureOpen();
    return database
      .prepare(
        "SELECT id, createdAt, lastAccessedAt, size FROM documents ORDER BY lastAccessedAt ASC, id COLLATE BINARY ASC"
      )
      .all()
      .map(documentFromRow);
  };

  const getDocumentMetadataScanWatermark = () => {
    ensureOpen();
    const row = database
      .prepare("SELECT COALESCE(MAX(rowid), 0) AS watermark FROM documents")
      .get();
    return readInteger(row === undefined ? undefined : rowValue(row, "watermark"), "watermark");
  };

  const listDocumentMetadataCandidates = (
    cutoff: number,
    limit: number,
    after?: DocumentMetadataAccessCursor,
    watermark?: number
  ) => {
    ensureOpen();
    const normalizedCutoff = validateNonNegativeInteger(cutoff, "cutoff");
    const normalizedLimit = validatePageLimit(limit);
    const normalizedWatermark =
      watermark === undefined ? undefined : validateNonNegativeInteger(watermark, "watermark");
    const cursor =
      after === undefined
        ? undefined
        : {
            lastAccessedAt: validateNonNegativeInteger(
              after.lastAccessedAt,
              "lastAccessedAt cursor"
            ),
            id: validateId(after.id),
          };
    const cursorClause =
      cursor === undefined
        ? ""
        : " AND (d.lastAccessedAt > :afterLastAccessedAt OR (d.lastAccessedAt = :afterLastAccessedAt AND d.id COLLATE BINARY > :afterId))";
    const watermarkClause = normalizedWatermark === undefined ? "" : " AND d.rowid <= :watermark";
    const rows = database
      .prepare(
        `SELECT d.id, d.createdAt, d.lastAccessedAt, d.size, g.generation
         FROM documents AS d
         JOIN ${GENERATION_TABLE_NAME} AS g ON g.id = d.id
         WHERE d.lastAccessedAt < :cutoff${watermarkClause}${cursorClause}
         ORDER BY d.lastAccessedAt ASC, d.id COLLATE BINARY ASC
         LIMIT :limit`
      )
      .all({
        ":cutoff": normalizedCutoff,
        ":limit": normalizedLimit + 1,
        ...(normalizedWatermark === undefined ? {} : { ":watermark": normalizedWatermark }),
        ...(cursor === undefined
          ? {}
          : {
              ":afterLastAccessedAt": cursor.lastAccessedAt,
              ":afterId": cursor.id,
            }),
      })
      .map(documentSnapshotFromRow);
    const hasMore = rows.length > normalizedLimit;
    return {
      rows: hasMore ? rows.slice(0, normalizedLimit) : rows,
      hasMore,
    } satisfies DocumentMetadataPage;
  };

  const listDocumentMetadataPage = (limit: number, afterId?: string, watermark?: number) => {
    ensureOpen();
    const normalizedLimit = validatePageLimit(limit);
    const cursor = afterId === undefined ? undefined : validateId(afterId);
    const normalizedWatermark =
      watermark === undefined ? undefined : validateNonNegativeInteger(watermark, "watermark");
    const watermarkClause = normalizedWatermark === undefined ? "" : "WHERE d.rowid <= :watermark";
    const cursorClause =
      cursor === undefined
        ? ""
        : `${watermarkClause === "" ? "WHERE" : " AND"} d.id COLLATE BINARY > :afterId`;
    const rows = database
      .prepare(
        `SELECT d.id, d.createdAt, d.lastAccessedAt, d.size, g.generation
         FROM documents AS d
         JOIN ${GENERATION_TABLE_NAME} AS g ON g.id = d.id
         ${watermarkClause}${cursorClause}
         ORDER BY d.id COLLATE BINARY ASC
         LIMIT :limit`
      )
      .all({
        ":limit": normalizedLimit + 1,
        ...(normalizedWatermark === undefined ? {} : { ":watermark": normalizedWatermark }),
        ...(cursor === undefined ? {} : { ":afterId": cursor }),
      })
      .map(documentSnapshotFromRow);
    const hasMore = rows.length > normalizedLimit;
    return {
      rows: hasMore ? rows.slice(0, normalizedLimit) : rows,
      hasMore,
    } satisfies DocumentMetadataPage;
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

  const deleteGenerationAfterDocumentDelete = (id: string, generation?: string) => {
    const generationClause = generation === undefined ? "" : " AND generation = :generation";
    database
      .prepare(
        `DELETE FROM ${GENERATION_TABLE_NAME}
         WHERE id = :id${generationClause}
           AND NOT EXISTS (SELECT 1 FROM documents WHERE documents.id = :id)`
      )
      .run({
        ":id": id,
        ...(generation === undefined ? {} : { ":generation": generation }),
      });
  };

  const deleteDocument = (id: string) => {
    ensureOpen();
    return inTransaction(database, () => {
      const documentId = validateId(id);
      const result = database
        .prepare("DELETE FROM documents WHERE id = :id")
        .run({ ":id": documentId });
      if (result.changes > 0) {
        deleteGenerationAfterDocumentDelete(documentId);
      }
      return result.changes > 0;
    });
  };

  const deleteDocumentIfLastAccessedBefore = (
    candidate: string | DocumentMetadataSnapshot,
    cutoff: number
  ) => {
    ensureOpen();
    const timestamp = validateNonNegativeInteger(cutoff, "cutoff");
    const expected =
      typeof candidate === "string"
        ? { id: validateId(candidate), generation: undefined }
        : {
            ...validateMetadata(candidate),
            generation: validateGeneration(candidate.generation),
          };
    return inTransaction(database, () => {
      const row = database
        .prepare("SELECT id, createdAt, lastAccessedAt, size FROM documents WHERE id = :id")
        .get({ ":id": expected.id });
      if (row === undefined) {
        return undefined;
      }
      const metadata = documentFromRow(row);
      const generationClause =
        expected.generation === undefined ? "" : " AND g.generation = :generation";
      const result = database
        .prepare(
          `DELETE FROM documents
           WHERE id = :id
             AND lastAccessedAt < :cutoff
             AND EXISTS (
               SELECT 1 FROM ${GENERATION_TABLE_NAME} AS g
               WHERE g.id = documents.id${generationClause}
             )`
        )
        .run({
          ":id": expected.id,
          ":cutoff": timestamp,
          ...(expected.generation === undefined ? {} : { ":generation": expected.generation }),
        });
      if (result.changes > 0) {
        deleteGenerationAfterDocumentDelete(expected.id, expected.generation);
        return metadata;
      }
      return undefined;
    });
  };

  const deleteDocumentIfMatches = (metadata: DocumentMetadataMatch) => {
    ensureOpen();
    const normalized = {
      ...validateMetadata(metadata),
      generation: validateGeneration(metadata.generation),
    };
    return inTransaction(database, () => {
      const result = database
        .prepare(
          `DELETE FROM documents
           WHERE id = :id
             AND createdAt = :createdAt
             AND lastAccessedAt = :lastAccessedAt
             AND size = :size
             AND EXISTS (
               SELECT 1 FROM ${GENERATION_TABLE_NAME} AS g
               WHERE g.id = documents.id AND g.generation = :generation
             )`
        )
        .run({
          ":id": normalized.id,
          ":createdAt": normalized.createdAt,
          ":lastAccessedAt": normalized.lastAccessedAt,
          ":size": normalized.size,
          ":generation": normalized.generation,
        });
      if (result.changes > 0) {
        deleteGenerationAfterDocumentDelete(normalized.id, normalized.generation);
        return true;
      }
      return false;
    });
  };

  return {
    close,
    insertDocumentMetadata,
    getDocumentMetadata,
    listDocumentMetadata,
    getDocumentMetadataScanWatermark,
    listDocumentMetadataCandidates,
    listDocumentMetadataPage,
    recordDocumentAccess,
    getDocumentAggregate,
    deleteDocument,
    deleteDocumentIfLastAccessedBefore,
    deleteDocumentIfMatches,
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
