"use node";

import { UTApi } from "uploadthing/server";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { deleteUploadThingFile } from "./document-deletion-storage";

export const processDeletion = internalAction({
  args: { jobId: v.id("deletionJobs") },
  handler: async (ctx, { jobId }) => {
    const claim = await ctx.runMutation(internal.documents.claimDeletion, { jobId });
    if (!claim) return;

    try {
      const token = process.env["UPLOADTHING_TOKEN"];
      if (!token) throw new Error("UploadThing is not configured for deletion");
      await deleteUploadThingFile(new UTApi({ token }), claim.storageKey);
      await ctx.runMutation(internal.documents.finishDeletion, { jobId, attempts: claim.attempts });
    } catch (error) {
      // biome-ignore lint/suspicious/noConsole: Convex logs expose failed background attempts.
      console.error("Document deletion attempt failed", error);
      await ctx.runMutation(internal.documents.deferDeletion, { jobId, attempts: claim.attempts });
    }
  },
});
