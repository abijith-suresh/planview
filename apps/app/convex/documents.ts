import { v } from "convex/values";

import { internalQuery, mutation, query } from "./_generated/server";

const requireOwnerId = async (ctx: {
  auth: { getUserIdentity: () => Promise<{ subject: string } | null> };
}) => {
  const identity = await ctx.auth.getUserIdentity();

  if (!identity) {
    throw new Error("Authentication required");
  }

  return identity.subject;
};

export const list = query({
  args: {},
  handler: async (ctx) => {
    const ownerId = await requireOwnerId(ctx);

    return await ctx.db
      .query("documents")
      .withIndex("by_owner_createdAt", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(100);
  },
});

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireOwnerId(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

export const create = mutation({
  args: {
    title: v.string(),
    storageId: v.id("_storage"),
    contentType: v.string(),
    sizeBytes: v.number(),
  },
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const now = Date.now();

    return await ctx.db.insert("documents", {
      ownerId,
      title: args.title.trim() || "Untitled HTML",
      storageId: args.storageId,
      contentType: args.contentType,
      sizeBytes: args.sizeBytes,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const remove = mutation({
  args: { id: v.id("documents") },
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const document = await ctx.db.get(args.id);

    if (!document || document.ownerId !== ownerId) {
      throw new Error("Document not found");
    }

    await ctx.storage.delete(document.storageId);
    await ctx.db.delete(args.id);
  },
});

export const getContent = internalQuery({
  args: {
    id: v.id("documents"),
    ownerId: v.string(),
  },
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.id);

    if (!document || document.ownerId !== args.ownerId) {
      return null;
    }

    return {
      storageId: document.storageId,
      contentType: document.contentType,
    };
  },
});
