import { v } from "convex/values";

import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { resolveDocumentShare, setDocumentSharing } from "./documentSharingModel";
import { verifyMcpDocumentProof, type McpDocumentAction, type McpDocumentProof } from "./mcpProof";

const proofValidator = v.object({ expiresAt: v.number(), signature: v.string() });

const update = (ctx: MutationCtx, id: Id<"documents">, ownerId: string, hash: string | undefined) =>
  setDocumentSharing(
    {
      read: () => ctx.db.get(id),
      update: (shareTokenHash) => ctx.db.patch(id, { shareTokenHash }),
    },
    ownerId,
    hash
  );

const requireOwner = async (ctx: MutationCtx) => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Authentication required");
  return identity.subject;
};

const requireMcpOwner = async (
  action: McpDocumentAction,
  ownerId: string,
  arguments_: string[],
  proof: McpDocumentProof
) => {
  const secret = process.env["DOCUMENT_MUTATION_SECRET"];
  if (!secret || new TextEncoder().encode(secret).length < 32) {
    throw new Error("Document mutation signing is not configured");
  }
  if (
    !ownerId ||
    !(await verifyMcpDocumentProof(secret, { action, ownerId, arguments: arguments_ }, proof))
  ) {
    throw new Error("Invalid MCP document proof");
  }
  return ownerId;
};

export const enable = mutation({
  args: { id: v.id("documents"), tokenHash: v.string() },
  handler: async (ctx, { id, tokenHash }) => update(ctx, id, await requireOwner(ctx), tokenHash),
});

export const disable = mutation({
  args: { id: v.id("documents") },
  handler: async (ctx, { id }) => update(ctx, id, await requireOwner(ctx), undefined),
});

export const enableWithMcpProof = mutation({
  args: {
    id: v.id("documents"),
    ownerId: v.string(),
    tokenHash: v.string(),
    proof: proofValidator,
  },
  handler: async (ctx, { id, ownerId, tokenHash, proof }) =>
    update(
      ctx,
      id,
      await requireMcpOwner("create-share", ownerId, [id, tokenHash], proof),
      tokenHash
    ),
});

export const disableWithMcpProof = mutation({
  args: { id: v.id("documents"), ownerId: v.string(), proof: proofValidator },
  handler: async (ctx, { id, ownerId, proof }) =>
    update(ctx, id, await requireMcpOwner("revoke-share", ownerId, [id], proof), undefined),
});

export const resolve = query({
  args: { id: v.id("documents"), token: v.string() },
  handler: async (ctx, { id, token }) => {
    const document = await resolveDocumentShare(() => ctx.db.get(id), token);
    if (!document) return null;
    const legacyReadUrl = document.storageId
      ? await ctx.storage.getUrl(document.storageId as Id<"_storage">)
      : null;
    return { document, legacyReadUrl };
  },
});
