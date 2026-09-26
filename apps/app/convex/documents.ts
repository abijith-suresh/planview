import { v } from "convex/values";
import { makeFunctionReference, paginationOptsValidator } from "convex/server";

import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { verifyCreateDocumentProof, type DocumentMutationProof } from "./document-proof";

const uploadThingLocatorPrefix = (ownerId: string) => `uploadthing-custom-id:${ownerId}:`;
const maxHtmlSizeBytes = 8 * 1024 * 1024;
const proofValidator = v.object({ expiresAt: v.number(), signature: v.string() });
const createArgs = {
  title: v.string(),
  storageProvider: v.string(),
  storageKey: v.string(),
  contentType: v.string(),
  sizeBytes: v.number(),
  proof: proofValidator,
};
type CreateArgs = {
  title: string;
  storageProvider: string;
  storageKey: string;
  contentType: string;
  sizeBytes: number;
  proof: DocumentMutationProof;
};
const deletionWorker = makeFunctionReference<"action", { jobId: Id<"deletionJobs"> }>(
  "documentDeletion:processDeletion"
);
const deletionLeaseMs = 11 * 60_000;

export const deletionRetryDelay = (attempts: number) =>
  Math.min(60 * 60_000, 30_000 * 2 ** Math.min(attempts - 1, 7));

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
      .withIndex("by_owner_active_createdAt", (q) =>
        q.eq("ownerId", ownerId).eq("deletionRequestedAt", undefined)
      )
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
      .withIndex("by_owner_active_createdAt", (q) =>
        q.eq("ownerId", ownerId).eq("deletionRequestedAt", undefined)
      )
      .order("desc")
      .paginate(paginationOpts);
  },
});

const createForOwner = async (ctx: MutationCtx, ownerId: string, args: CreateArgs) => {
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
  if (existing) {
    if (existing.deletionRequestedAt !== undefined) {
      throw new Error("Document is being deleted");
    }
    return existing._id;
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
};

export const create = mutation({
  args: createArgs,
  handler: async (ctx, args) => createForOwner(ctx, await requireOwnerId(ctx), args),
});

export const createWithCliCredential = mutation({
  args: { ...createArgs, tokenHash: v.string() },
  handler: async (ctx, args) => {
    if (!/^[a-f0-9]{64}$/.test(args.tokenHash)) throw new Error("Invalid CLI credential");
    const credential = await ctx.db
      .query("cliCredentials")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
      .first();
    if (!credential || credential.revokedAt !== undefined) {
      throw new Error("CLI credential is invalid or revoked");
    }
    return createForOwner(ctx, credential.ownerId, args);
  },
});

export const requestDeletion = mutation({
  args: { id: v.id("documents") },
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const document = await ctx.db.get(args.id);

    if (!document || document.ownerId !== ownerId) {
      return "not_found" as const;
    }

    if (document.deletionRequestedAt !== undefined) {
      return "accepted" as const;
    }

    if (document.storageProvider && document.storageKey) {
      if (document.storageProvider !== "uploadthing") {
        throw new Error("Unsupported document storage provider");
      }
      const now = Date.now();
      await ctx.db.patch(args.id, { deletionRequestedAt: now });
      const jobId = await ctx.db.insert("deletionJobs", {
        documentId: args.id,
        storageKey: document.storageKey,
        nextAttemptAt: now,
        attempts: 0,
      });
      await ctx.scheduler.runAfter(0, deletionWorker, { jobId });
      return "accepted" as const;
    }

    if (document.storageId) {
      await ctx.storage.delete(document.storageId);
    }

    await ctx.db.delete(args.id);
    return "deleted" as const;
  },
});

export const get = query({
  args: { id: v.id("documents") },
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const document = await ctx.db.get(args.id);

    if (!document || document.ownerId !== ownerId || document.deletionRequestedAt !== undefined) {
      return null;
    }

    return document;
  },
});

export const claimDeletion = internalMutation({
  args: { jobId: v.id("deletionJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    const now = Date.now();
    if (!job || job.nextAttemptAt > now) return null;

    const attempts = job.attempts + 1;
    await ctx.db.patch(args.jobId, { attempts, nextAttemptAt: now + deletionLeaseMs });
    return { attempts, storageKey: job.storageKey };
  },
});

export const finishDeletion = internalMutation({
  args: { jobId: v.id("deletionJobs"), attempts: v.number() },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.attempts !== args.attempts) return;
    const document = await ctx.db.get(job.documentId);
    if (document) await ctx.db.delete(job.documentId);
    await ctx.db.delete(args.jobId);
  },
});

export const deferDeletion = internalMutation({
  args: { jobId: v.id("deletionJobs"), attempts: v.number() },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.attempts !== args.attempts) return;
    const delay = deletionRetryDelay(job.attempts);
    await ctx.db.patch(args.jobId, { nextAttemptAt: Date.now() + delay });
    await ctx.scheduler.runAfter(delay, deletionWorker, { jobId: args.jobId });
  },
});

export const reconcileDeletions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const due = await ctx.db
      .query("deletionJobs")
      .withIndex("by_nextAttemptAt", (q) => q.lte("nextAttemptAt", Date.now()))
      .take(100);
    for (const job of due) {
      await ctx.scheduler.runAfter(0, deletionWorker, { jobId: job._id });
    }
  },
});

export const getContent = internalQuery({
  args: {
    id: v.id("documents"),
    ownerId: v.string(),
  },
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.id);

    if (
      !document ||
      document.ownerId !== args.ownerId ||
      document.deletionRequestedAt !== undefined
    ) {
      return null;
    }

    if (!document.storageId) return null;

    return {
      storageId: document.storageId,
      contentType: document.contentType,
    };
  },
});
