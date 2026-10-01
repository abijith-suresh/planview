import { ConvexError } from "convex/values";

import type { MutationCtx } from "./_generated/server.js";

export const defaultAccountStorageQuotaBytes = 500_000_000;
export const uploadLifetimeMs = 5 * 60_000;
// Bound the commit/recovery window. An unknown provider outcome is never
// considered safe for automatic cleanup merely because this grace elapsed.
export const uploadCleanupGraceMs = 10 * 60_000;

export function accountStorageQuotaBytes(value = process.env["ACCOUNT_STORAGE_QUOTA_BYTES"]) {
  if (value === undefined) return defaultAccountStorageQuotaBytes;
  if (!/^\d+$/.test(value))
    throw new Error("ACCOUNT_STORAGE_QUOTA_BYTES must be a positive integer");
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 1) {
    throw new Error("ACCOUNT_STORAGE_QUOTA_BYTES must be a positive integer");
  }
  return bytes;
}

async function accountUsage(ctx: MutationCtx, ownerId: string) {
  const existing = await ctx.db
    .query("accountStorageUsage")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .unique();
  if (existing) {
    if (!Number.isSafeInteger(existing.usedBytes) || existing.usedBytes < 0)
      throw new Error("Account storage accounting is invalid");
    return existing;
  }

  // Seed each alpha account once. The owner-index read and inserted counter
  // participate in the same transaction, including concurrent first uploads.
  // Very large legacy accounts need an offline, paged backfill before admission.
  const documents = await ctx.db
    .query("documents")
    .withIndex("by_owner_createdAt", (q) => q.eq("ownerId", ownerId))
    .collect();
  const reservations = await ctx.db
    .query("uploadReservations")
    .withIndex("by_owner_storageKey", (q) => q.eq("ownerId", ownerId))
    .collect();
  const usedBytes = [...documents, ...reservations].reduce((sum, row) => sum + row.sizeBytes, 0);
  if (!Number.isSafeInteger(usedBytes) || usedBytes < 0) {
    throw new Error("Account storage accounting is invalid");
  }
  const updatedAt = Date.now();
  const id = await ctx.db.insert("accountStorageUsage", { ownerId, usedBytes, updatedAt });
  return { _id: id, ownerId, usedBytes, updatedAt };
}

export async function reserveAccountBytes(
  ctx: MutationCtx,
  ownerId: string,
  requestedBytes: number
) {
  const usage = await accountUsage(ctx, ownerId);
  const limitBytes = accountStorageQuotaBytes();
  if (requestedBytes > limitBytes - usage.usedBytes) {
    throw new ConvexError({
      code: "STORAGE_QUOTA_EXCEEDED",
      message:
        "Your account storage limit has been reached. Delete documents before uploading more.",
      limitBytes,
      usedBytes: usage.usedBytes,
      requestedBytes,
    });
  }
  await ctx.db.patch(usage._id, {
    usedBytes: usage.usedBytes + requestedBytes,
    updatedAt: Date.now(),
  });
}

export async function releaseAccountBytes(
  ctx: MutationCtx,
  ownerId: string,
  releasedBytes: number
) {
  const usage = await accountUsage(ctx, ownerId);
  if (
    !Number.isSafeInteger(releasedBytes) ||
    releasedBytes < 0 ||
    releasedBytes > usage.usedBytes
  ) {
    throw new Error("Account storage accounting is invalid");
  }
  await ctx.db.patch(usage._id, {
    usedBytes: usage.usedBytes - releasedBytes,
    updatedAt: Date.now(),
  });
}
