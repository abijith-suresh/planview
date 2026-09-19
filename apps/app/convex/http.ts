import { httpRouter } from "convex/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

import { authComponent, createAuth } from "./betterAuth/auth";

const http = httpRouter();

authComponent.registerRoutes(http, createAuth);

http.route({
  path: "/documents/content",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const identity = await ctx.auth.getUserIdentity();

    if (!identity) {
      return new Response("Unauthorized", { status: 401 });
    }

    const id = new URL(request.url).searchParams.get("id");

    if (!id) {
      return new Response("Document id is required", { status: 400 });
    }

    try {
      const document = await ctx.runQuery(internal.documents.getContent, {
        id: id as Id<"documents">,
        ownerId: identity.subject,
      });

      if (!document) {
        return new Response("Not found", { status: 404 });
      }

      const blob = await ctx.storage.get(document.storageId);

      if (!blob) {
        return new Response("Not found", { status: 404 });
      }

      return new Response(blob, {
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Security-Policy":
            "default-src 'none'; img-src data: https:; style-src 'unsafe-inline' https:; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox",
          "Content-Type": "text/html; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }),
});

export default http;
