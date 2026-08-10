import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import {
  CURRENT_SCHEMA_VERSION,
  StorageClosedError,
  StorageInvariantError,
  StorageMigrationError,
  StorageOpenError,
  StoragePathError,
  openStorage,
} from "../dist/index.js";

const withTempDirectory = async (prefix, callback) => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const withStorage = (callback) =>
  withTempDirectory("planview-storage-", async (directory) => {
    const databasePath = join(directory, "metadata.sqlite");
    let storage;
    try {
      storage = Effect.runSync(openStorage(databasePath));
      return await callback({ databasePath, directory, storage });
    } finally {
      storage?.close();
    }
  });

const metadata = (id, createdAt, size, lastAccessedAt = createdAt) => ({
  id,
  createdAt,
  lastAccessedAt,
  size,
});

const inspectSchema = (databasePath) => {
  const database = new DatabaseSync(databasePath);
  try {
    return {
      version: database.prepare("PRAGMA user_version").get().user_version,
      columns: database
        .prepare("PRAGMA table_info(documents)")
        .all()
        .map((row) => row.name),
    };
  } finally {
    database.close();
  }
};

const createDatabase = (databasePath, schema, version = 1) => {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(schema);
    database.exec(`PRAGMA user_version = ${version}`);
  } finally {
    database.close();
  }
};

const waitForWorkerMessage = (worker, expected) =>
  new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message === expected) {
        worker.off("error", onError);
        resolve();
      }
    };
    const onError = (error) => {
      worker.off("message", onMessage);
      reject(error);
    };
    worker.on("message", onMessage);
    worker.once("error", onError);
  });

const openWorker = (databasePath) => {
  const worker = new Worker(new URL("./concurrent-opener-worker.mjs", import.meta.url), {
    workerData: { databasePath },
  });
  return { worker, ready: waitForWorkerMessage(worker, "ready") };
};

test("opens a new database, applies v1, and persists the exact metadata schema", () => {
  return withStorage(({ databasePath }) => {
    assert.deepEqual(inspectSchema(databasePath), {
      version: CURRENT_SCHEMA_VERSION,
      columns: ["id", "createdAt", "lastAccessedAt", "size"],
    });
  });
});

test("migrates an existing version-zero database transactionally", () =>
  withTempDirectory("planview-storage-migration-", (directory) => {
    const databasePath = join(directory, "metadata.sqlite");
    createDatabase(databasePath, "", 0);

    const storage = Effect.runSync(openStorage(databasePath));
    try {
      assert.deepEqual(inspectSchema(databasePath), {
        version: 1,
        columns: ["id", "createdAt", "lastAccessedAt", "size"],
      });
    } finally {
      storage.close();
    }
  }));

test("serializes concurrent v0 openers and lets both observe the committed migration", () =>
  withTempDirectory("planview-storage-concurrent-", async (directory) => {
    const databasePath = join(directory, "metadata.sqlite");
    createDatabase(databasePath, "", 0);

    let blocker;
    const openers = [];
    try {
      blocker = new DatabaseSync(databasePath);
      blocker.exec("BEGIN IMMEDIATE");
      openers.push(openWorker(databasePath));
      openers.push(openWorker(databasePath));
      await Promise.all(openers.map(({ ready }) => ready));
      openers.forEach(({ worker }) => {
        worker.postMessage("open");
      });
      await Promise.all(openers.map(({ worker }) => waitForWorkerMessage(worker, "opening")));
      blocker.exec("COMMIT");
      await Promise.all(openers.map(({ worker }) => waitForWorkerMessage(worker, "opened")));
      assert.deepEqual(inspectSchema(databasePath), {
        version: 1,
        columns: ["id", "createdAt", "lastAccessedAt", "size"],
      });
      openers.forEach(({ worker }) => {
        worker.postMessage("close");
      });
      await Promise.all(openers.map(({ worker }) => waitForWorkerMessage(worker, "closed")));
    } finally {
      try {
        blocker?.exec("ROLLBACK");
      } catch {
        // The transaction may already have been committed.
      }
      blocker?.close();
      await Promise.all(openers.map(({ worker }) => worker.terminate()));
    }
  }));

test("rejects a claimed v1 database whose schema omits required semantics without repair", () =>
  withTempDirectory("planview-storage-schema-", (directory) => {
    const databasePath = join(directory, "metadata.sqlite");
    const incompatibleSchema = `
      CREATE TABLE documents (
        id TEXT,
        createdAt INTEGER NOT NULL,
        lastAccessedAt INTEGER NOT NULL,
        size INTEGER NOT NULL
      )
    `;
    createDatabase(databasePath, incompatibleSchema);

    assert.throws(
      () => Effect.runSync(openStorage(databasePath)),
      (error) => error instanceof StorageMigrationError && /schema/i.test(error.message)
    );
    const database = new DatabaseSync(databasePath);
    try {
      assert.equal(database.prepare("PRAGMA user_version").get().user_version, 1);
      const actualSchema = database
        .prepare("SELECT sql FROM sqlite_schema WHERE name = 'documents'")
        .get().sql;
      assert.equal(
        actualSchema.replace(/\s+/g, " ").trim(),
        incompatibleSchema.replace(/\s+/g, " ").trim()
      );
    } finally {
      database.close();
    }
  }));

test("rejects a claimed v1 database with a trigger that could bypass monotonic access", () =>
  withTempDirectory("planview-storage-trigger-", (directory) => {
    const databasePath = join(directory, "metadata.sqlite");
    const schemaWithTrigger = `
      CREATE TABLE documents (
        id TEXT PRIMARY KEY NOT NULL,
        createdAt INTEGER NOT NULL,
        lastAccessedAt INTEGER NOT NULL,
        size INTEGER NOT NULL
      ) STRICT;
      CREATE TRIGGER rewrite_access AFTER UPDATE OF lastAccessedAt ON documents
      BEGIN
        UPDATE documents SET lastAccessedAt = 0 WHERE id = NEW.id;
      END;
    `;
    createDatabase(databasePath, schemaWithTrigger);

    assert.throws(
      () => Effect.runSync(openStorage(databasePath)),
      (error) =>
        error instanceof StorageMigrationError &&
        /unexpected user schema object/i.test(error.message)
    );
  }));

test("supports immutable insert, lookup, access recording, aggregate, and delete", () => {
  return withStorage(({ storage }) => {
    const original = metadata("doc-1", 1_700_000_000_000, 120, 1_700_000_000_100);
    storage.insertDocumentMetadata(original);

    assert.deepEqual(storage.getDocumentMetadata("doc-1"), original);
    assert.equal(storage.recordDocumentAccess("doc-1", 1_700_000_000_200), true);
    assert.throws(
      () => storage.recordDocumentAccess("doc-1", 1_700_000_000_150),
      (error) =>
        error instanceof StorageInvariantError &&
        /must not be earlier than lastAccessedAt/.test(error.message)
    );
    assert.deepEqual(storage.getDocumentMetadata("doc-1"), {
      ...original,
      lastAccessedAt: 1_700_000_000_200,
    });
    assert.deepEqual(storage.getDocumentAggregate(), { count: 1, size: 120 });
    assert.equal(storage.deleteDocument("doc-1"), true);
    assert.equal(storage.getDocumentMetadata("doc-1"), undefined);
    assert.deepEqual(storage.getDocumentAggregate(), { count: 0, size: 0 });
    assert.equal(storage.deleteDocument("doc-1"), false);
  });
});

test("persists metadata across close and reopen", () =>
  withTempDirectory("planview-storage-persistence-", (directory) => {
    const databasePath = join(directory, "metadata.sqlite");
    let first;
    let second;
    try {
      first = Effect.runSync(openStorage(databasePath));
      const expected = metadata("persistent", 42, 9, 43);
      first.insertDocumentMetadata(expected);
      first.close();
      first = undefined;

      second = Effect.runSync(openStorage(databasePath));
      assert.deepEqual(second.getDocumentMetadata("persistent"), expected);
      assert.deepEqual(second.getDocumentAggregate(), { count: 1, size: 9 });
    } finally {
      first?.close();
      second?.close();
    }
  }));

test("enforces identifier, size, and epoch timestamp invariants", () => {
  return withStorage(({ storage }) => {
    for (const invalid of [
      metadata("", 1, 1),
      metadata("   ", 1, 1),
      metadata("negative-size", 1, -1),
      metadata("fractional-size", 1, 1.5),
      metadata("negative-created", -1, 1),
      metadata("unsafe-created", Number.MAX_SAFE_INTEGER + 1, 1),
      metadata("before-created", 2, 1, 1),
    ]) {
      assert.throws(() => storage.insertDocumentMetadata(invalid), StorageInvariantError);
    }

    storage.insertDocumentMetadata(metadata("valid", 10, 0));
    assert.throws(
      () => storage.recordDocumentAccess("valid", 9),
      (error) => error instanceof StorageInvariantError && error.field === "accessedAt"
    );
    assert.equal(storage.recordDocumentAccess("missing", 10), false);
  });
});

test("rejects duplicate ids without mutating the existing immutable row", () => {
  return withStorage(({ storage }) => {
    const original = metadata("same-id", 1, 10);
    storage.insertDocumentMetadata(original);
    assert.throws(
      () => storage.insertDocumentMetadata(metadata("same-id", 2, 20)),
      /UNIQUE|constraint/i
    );
    assert.deepEqual(storage.getDocumentMetadata("same-id"), original);
  });
});

test("closes idempotently and rejects operations after close", () => {
  return withStorage(({ storage }) => {
    storage.close();
    storage.close();
    assert.throws(() => storage.getDocumentAggregate(), StorageClosedError);
  });
});

test("reports clear typed errors for invalid and unavailable database paths", () => {
  assert.throws(
    () => Effect.runSync(openStorage("relative.sqlite")),
    (error) => error instanceof StoragePathError
  );

  return withTempDirectory("planview-storage-path-", (directory) => {
    assert.throws(
      () => Effect.runSync(openStorage(join(directory, "missing", "metadata.sqlite"))),
      (error) =>
        error instanceof StorageOpenError &&
        /Could not open SQLite metadata storage/.test(error.message)
    );
  });
});
