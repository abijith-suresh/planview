import { v } from "convex/values";

import { mutation, query } from "./_generated/server";

const tokenHashPattern = /^[a-f0-9]{64}$/;

export const issue = mutation({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Authentication required");
    if (!tokenHashPattern.test(tokenHash)) throw new Error("Invalid CLI credential hash");
    const existing = await ctx.db
      .query("cliCredentials")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
      .first();
    if (existing) throw new Error("CLI credential already exists");

    await ctx.db.insert("cliCredentials", {
      ownerId: identity.subject,
      tokenHash,
      createdAt: Date.now(),
    });
  },
});

export const lookup = query({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    if (!tokenHashPattern.test(tokenHash)) return null;
    const credential = await ctx.db
      .query("cliCredentials")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
      .first();
    if (!credential || credential.revokedAt !== undefined) {
      return null;
    }
    return { subject: credential.ownerId };
  },
});

export const revoke = mutation({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    if (!tokenHashPattern.test(tokenHash)) return;
    const credential = await ctx.db
      .query("cliCredentials")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
      .first();
    if (credential && credential.revokedAt === undefined) {
      await ctx.db.patch(credential._id, { revokedAt: Date.now() });
    }
  },
});
