import type { DatabaseSync } from "node:sqlite";
import { StorageInvariantError } from "./metadata-contracts.js";

export const readInteger = (value: unknown, field: string) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new StorageInvariantError({
      field,
      message: `SQLite returned a non-safe integer for ${field}.`,
    });
  }

  return value;
};

export const readText = (value: unknown, field: string) => {
  if (typeof value !== "string") {
    throw new StorageInvariantError({
      field,
      message: `SQLite returned non-text data for ${field}.`,
    });
  }

  return value;
};

export const rowValue = (row: Record<string, unknown>, key: string) => row[key];

export const inTransaction = <Value>(database: DatabaseSync, operation: () => Value) => {
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
