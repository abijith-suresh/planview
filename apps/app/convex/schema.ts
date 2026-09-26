import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  documents: defineTable({
    ownerId: v.string(),
    title: v.string(),
    // `storageId` is retained for documents created before the external
    // storage boundary was introduced. New documents use the provider/key
    // pair below so the storage implementation can change independently.
    storageId: v.optional(v.id("_storage")),
    storageProvider: v.optional(v.string()),
    storageKey: v.optional(v.string()),
    contentType: v.string(),
    sizeBytes: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_createdAt", ["ownerId", "createdAt"])
    .index("by_owner_storageKey", ["ownerId", "storageKey"]),
});
