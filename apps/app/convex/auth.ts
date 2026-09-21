import { query } from "./_generated/server";

export const currentUser = query({
  args: {},
  handler: async (ctx) => ctx.auth.getUserIdentity(),
});
