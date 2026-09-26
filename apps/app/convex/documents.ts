import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";

import { internalQuery, mutation, query } from "./_generated/server";
import { verifyCreateDocumentProof, verifyRemoveDocumentProof } from "./document-proof";

const uploadThingLocatorPrefix = (ownerId: string) => `uploadthing-custom-id:${ownerId}:`;
const maxHtmlSizeBytes = 8 * 1024 * 1024;
const proofValidator = v.object({ expiresAt: v.number(), signature: v.string() });

const requireMutationSecret = () => {
  const secret = process.env["DOCUMENT_MUTATION_SECRET"];
  if (!secret || new TextEncoder().encode(secret).length < 32) {
    throw new Error("Document mutation signing is not configured");
  }
  return secret;
};

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

export const listPage = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const ownerId = await requireOwnerId(ctx);

    return await ctx.db
      .query("documents")
      .withIndex("by_owner_createdAt", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .paginate(paginationOpts);
  },
});

export const create = mutation({
  args: {
    title: v.string(),
    storageProvider: v.string(),
    storageKey: v.string(),
    contentType: v.string(),
    sizeBytes: v.number(),
    proof: proofValidator,
  },
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);

    if (
      args.storageProvider !== "uploadthing" ||
      !args.storageKey.startsWith(uploadThingLocatorPrefix(ownerId)) ||
      args.storageKey.length <= uploadThingLocatorPrefix(ownerId).length ||
      args.contentType !== "text/html" ||
      args.title.trim().length === 0 ||
      args.title.length > 200 ||
      !Number.isSafeInteger(args.sizeBytes) ||
      args.sizeBytes < 0 ||
      args.sizeBytes > maxHtmlSizeBytes
    ) {
      throw new Error("Invalid document metadata");
    }

    const validProof = await verifyCreateDocumentProof(
      requireMutationSecret(),
      {
        ownerId,
        title: args.title,
        storageProvider: args.storageProvider,
        storageKey: args.storageKey,
        contentType: args.contentType,
        sizeBytes: args.sizeBytes,
      },
      args.proof
    );
    if (!validProof) throw new Error("Invalid document mutation proof");

    const existing = await ctx.db
      .query("documents")
      .withIndex("by_owner_storageKey", (q) =>
        q.eq("ownerId", ownerId).eq("storageKey", args.storageKey)
      )
      .first();
    if (existing) return existing._id;

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
  args: { id: v.id("documents"), proof: proofValidator },
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const document = await ctx.db.get(args.id);

    if (!document || document.ownerId !== ownerId) {
      throw new Error("Document not found");
    }

    const validProof = await verifyRemoveDocumentProof(
      requireMutationSecret(),
      ownerId,
      args.id,
      args.proof
    );
    if (!validProof) throw new Error("Invalid document mutation proof");

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
