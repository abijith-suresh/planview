import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { createForOwner, requestDeletionForOwner } from "./documents";
import { verifyMcpDocumentProof, type McpDocumentAction } from "./mcp-proof";

const proofValidator = v.object({ expiresAt: v.number(), signature: v.string() });
const requireProof = async (
  action: McpDocumentAction,
  ownerId: string,
  arguments_: readonly (string | number | null)[],
  proof: { expiresAt: number; signature: string }
) => {
  const secret = process.env["DOCUMENT_MUTATION_SECRET"];
  if (!secret || new TextEncoder().encode(secret).length < 32) {
    throw new Error("Document mutation signing is not configured");
  }
  if (!(await verifyMcpDocumentProof(secret, { action, ownerId, arguments: arguments_ }, proof))) {
    throw new Error("Invalid MCP document proof");
  }
};

export const listPage = query({
  args: { ownerId: v.string(), paginationOpts: paginationOptsValidator, proof: proofValidator },
  handler: async (ctx, { ownerId, paginationOpts, proof }) => {
    const { cursor, numItems } = paginationOpts;
    if (!Number.isSafeInteger(numItems) || numItems < 1 || numItems > 50) {
      throw new Error("Invalid page size");
    }
    await requireProof("list", ownerId, [cursor ?? null, numItems], proof);
    return ctx.db
      .query("documents")
      .withIndex("by_owner_active_createdAt", (q) =>
        q.eq("ownerId", ownerId).eq("deletionRequestedAt", undefined)
      )
      .order("desc")
      .paginate(paginationOpts);
  },
});

export const get = query({
  args: { ownerId: v.string(), id: v.id("documents"), proof: proofValidator },
  handler: async (ctx, { ownerId, id, proof }) => {
    await requireProof("get", ownerId, [id], proof);
    const document = await ctx.db.get(id);
    if (!document || document.ownerId !== ownerId || document.deletionRequestedAt !== undefined) {
      return null;
    }
    const legacyReadUrl = document.storageId ? await ctx.storage.getUrl(document.storageId) : null;
    return { document, legacyReadUrl };
  },
});

export const create = mutation({
  args: {
    ownerId: v.string(),
    title: v.string(),
    storageProvider: v.string(),
    storageKey: v.string(),
    contentType: v.string(),
    sizeBytes: v.number(),
    proof: proofValidator,
    createProof: proofValidator,
  },
  handler: async (ctx, args) => {
    await requireProof(
      "create",
      args.ownerId,
      [args.title, args.storageProvider, args.storageKey, args.contentType, args.sizeBytes],
      args.proof
    );
    return createForOwner(ctx, args.ownerId, { ...args, proof: args.createProof });
  },
});

export const requestDeletion = mutation({
  args: { ownerId: v.string(), id: v.id("documents"), proof: proofValidator },
  handler: async (ctx, { ownerId, id, proof }) => {
    await requireProof("delete", ownerId, [id], proof);
    return requestDeletionForOwner(ctx, ownerId, id);
  },
});
