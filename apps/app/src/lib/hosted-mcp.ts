import { createMcpProtectedRequestHandler } from "@better-auth/mcp";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { createMcpDocumentService } from "./mcp-documents";

const siteUrl = process.env["SITE_URL"]?.replace(/\/$/, "");
const resource = siteUrl ? `${siteUrl}/mcp` : undefined;
const allowLegacyClients = process.env["MCP_ALLOW_LEGACY_CLIENTS"] === "true";

const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

const runTool = async (name: string, operation: () => Promise<unknown>) => {
  try {
    return result(await operation());
  } catch (error) {
    console.error("mcp.tool_failed", {
      name,
      errorType: error instanceof Error ? error.name : "UnknownError",
      at: error instanceof Error ? error.stack?.split("\n")[1]?.trim() : undefined,
    });
    throw error;
  }
};

const handler = createMcpHandler(
  ({ authInfo }) => {
    const ownerId = authInfo?.extra?.["userId"];
    if (typeof ownerId !== "string" || !ownerId) throw new Error("MCP identity is missing");
    const documents = createMcpDocumentService(ownerId);
    const server = new McpServer({ name: "planview-cloud", version: "0.1.0" });

    server.registerTool(
      "list_documents",
      {
        description: "List your cloud documents, newest first. Use nextCursor to continue.",
        inputSchema: z.object({
          cursor: z.string().nullable().optional(),
          limit: z.number().int().min(1).max(50).optional(),
        }),
        annotations: { readOnlyHint: true },
      },
      async ({ cursor, limit }) =>
        runTool("list_documents", () => documents.list(cursor ?? null, limit ?? 25))
    );

    server.registerTool(
      "read_document",
      {
        description: "Read your cloud document HTML in chunks of up to 32768 characters.",
        inputSchema: z.object({
          id: z.string().min(1),
          offset: z.number().int().min(0).optional(),
          maxCharacters: z.number().int().min(1).max(32_768).optional(),
        }),
        annotations: { readOnlyHint: true },
      },
      async ({ id, offset, maxCharacters }) =>
        runTool("read_document", () => documents.read(id, offset, maxCharacters))
    );

    server.registerTool(
      "upload_document",
      {
        description:
          "Upload an HTML document to your cloud workspace. Maximum encoded size is 8 MiB. Uploaded files are public during development.",
        inputSchema: z.object({ title: z.string().min(1).max(200), html: z.string() }),
        annotations: { readOnlyHint: false },
      },
      async ({ title, html }) => runTool("upload_document", () => documents.upload(title, html))
    );

    server.registerTool(
      "delete_document",
      {
        description:
          "Hide one of your documents immediately and queue storage cleanup with background retries.",
        inputSchema: z.object({ id: z.string().min(1) }),
        annotations: { destructiveHint: true },
      },
      async ({ id }) => runTool("delete_document", () => documents.delete(id))
    );
    return server;
  },
  // JSON escaping can expand an 8 MiB HTML string by up to six times.
  {
    legacy: allowLegacyClients ? "stateless" : "reject",
    maxRequestBodySize: 50 * 1024 * 1024,
    onerror: (error) =>
      console.error("mcp.transport_failed", {
        errorType: error.name,
        at: error.stack?.split("\n")[1]?.trim(),
      }),
  }
);

const protectedHandler =
  siteUrl && resource
    ? createMcpProtectedRequestHandler(
        {
          issuer: `${siteUrl}/api/auth`,
          audience: resource,
          jwksUrl: `${siteUrl}/api/auth/jwks`,
          requiredScopes: ["cloud:documents"],
        },
        (request, claims) => {
          const userId = claims.sub;
          if (!userId) return new Response(null, { status: 403 });
          const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
          if (!token) return new Response(null, { status: 401 });
          const clientId = claims["client_id"] ?? claims["azp"];
          return handler.fetch(request, {
            authInfo: {
              token,
              clientId: typeof clientId === "string" ? clientId : "unknown",
              scopes: typeof claims["scope"] === "string" ? claims["scope"].split(" ") : [],
              resource: new URL(resource),
              extra: { userId },
            },
          });
        }
      )
    : undefined;

export const handleHostedMcp = async (request: Request) => {
  if (!protectedHandler) {
    return Response.json({ error: "MCP is not configured" }, { status: 503 });
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(resource!).origin) {
    return new Response(null, { status: 403 });
  }
  const response = await protectedHandler(request);
  if (process.env["MCP_DIAGNOSTICS"] === "true") {
    console.info("mcp.response", { method: request.method, status: response.status });
  }
  return response;
};
