import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  documents: defineTable({
    ownerId: v.string(),
    title: v.string(),
    storageId: v.id("_storage"),
    contentType: v.string(),
    sizeBytes: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_owner_createdAt", ["ownerId", "createdAt"]),
});
