import { v } from "convex/values";

import { internalQuery, mutation, query } from "./_generated/server";

const uploadThingLocatorPrefix = (ownerId: string) => `uploadthing-custom-id:${ownerId}:`;

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

export const create = mutation({
  args: {
    title: v.string(),
    storageProvider: v.string(),
    storageKey: v.string(),
    contentType: v.string(),
    sizeBytes: v.number(),
  },
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);

    if (
      args.storageProvider !== "uploadthing" ||
      !args.storageKey.startsWith(uploadThingLocatorPrefix(ownerId))
    ) {
      throw new Error("The document storage locator does not belong to this account");
    }

    const now = Date.now();

    return await ctx.db.insert("documents", {
      ownerId,
      title: args.title.trim() || "Untitled HTML",
      storageProvider: args.storageProvider,
      storageKey: args.storageKey,
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

    if (document.storageId) {
      await ctx.storage.delete(document.storageId);
    }

    await ctx.db.delete(args.id);
  },
});

export const get = query({
  args: { id: v.id("documents") },
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const document = await ctx.db.get(args.id);

    if (!document || document.ownerId !== ownerId) {
      return null;
    }

    return document;
  },
});

// External storage is deleted by the application server through its provider
// adapter. This mutation removes only the Convex metadata after that succeeds.
export const removeMetadata = mutation({
  args: { id: v.id("documents") },
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const document = await ctx.db.get(args.id);

    if (!document || document.ownerId !== ownerId) {
      throw new Error("Document not found");
    }

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

    if (!document.storageId) return null;

    return {
      storageId: document.storageId,
      contentType: document.contentType,
    };
  },
});
