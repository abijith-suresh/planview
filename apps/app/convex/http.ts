import { httpRouter } from "convex/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

import { authComponent, createAuth } from "./betterAuth/auth";

const http = httpRouter();

// Uploaded documents may contain the JavaScript that agent-generated HTML
// commonly needs. Keep that code in a unique sandboxed origin so it cannot
// read the app's cookies or call the app as the signed-in user.
const previewContentSecurityPolicy = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "sandbox allow-scripts allow-modals allow-popups",
  "script-src 'unsafe-inline' https: blob:",
  "style-src 'unsafe-inline' https:",
  "img-src data: blob: https:",
  "font-src data: blob: https:",
  "media-src data: blob: https:",
  "connect-src https:",
  "worker-src blob: https:",
  "frame-src https:",
].join("; ");

const previewHeaders = (contentType: string) => ({
  "Cache-Control": "private, no-store",
  "Content-Disposition": "inline",
  "Content-Security-Policy": previewContentSecurityPolicy,
  "Content-Type": contentType,
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});

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
        headers: previewHeaders("text/html; charset=utf-8"),
      });
    } catch {
      return new Response("Preview unavailable", { status: 500 });
    }
  }),
});

// Temporary staging diagnostic. Set DEBUG_PUBLIC_PREVIEW=true only on the
// staging deployment while investigating preview failures.
http.route({
  path: "/debug/preview-latest",
  method: "GET",
  handler: httpAction(async (ctx) => {
    if (process.env.DEBUG_PUBLIC_PREVIEW !== "true") {
      return new Response("Not found", { status: 404 });
    }

    const document = await ctx.runQuery(internal.documents.latestContent, {});

    if (!document) {
      return new Response("No uploaded documents", { status: 404 });
    }

    try {
      const blob = await ctx.storage.get(document.storageId);

      if (!blob) {
        return new Response("Not found", { status: 404 });
      }

      return new Response(blob, {
        headers: {
          ...previewHeaders("text/html; charset=utf-8"),
          "X-Robots-Tag": "noindex, nofollow, noarchive",
        },
      });
    } catch {
      return new Response("Preview unavailable", { status: 500 });
    }
  }),
});

export default http;
