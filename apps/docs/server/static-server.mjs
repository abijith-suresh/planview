import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

const contentTypes = new Map(
  Object.entries({
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".xml": "application/xml; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
  })
);

const entityTagPattern = '(?:W/)?"[\\x21\\x23-\\x7e\\x80-\\xff]*"';
const entityTagList = new RegExp(`^\\s*${entityTagPattern}(?:\\s*,\\s*${entityTagPattern})*\\s*$`);
const entityTags = new RegExp(entityTagPattern, "g");

function matchesIfNoneMatch(value, etag) {
  if (!value) return false;
  if (value.trim() === "*") return true;
  if (!entityTagList.test(value)) return false;
  const opaqueTag = etag.replace(/^W\//, "");
  return [...value.matchAll(entityTags)].some(([tag]) => tag.replace(/^W\//, "") === opaqueTag);
}

export function validateBasePath(basePath) {
  if (typeof basePath !== "string" || !/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(basePath))
    throw new Error("Invalid documentation build base path");
  return basePath;
}

export async function createStaticDocsServer({ rootDirectory, basePath = "/" }) {
  const root = await realpath(rootDirectory);
  const base = validateBasePath(basePath).replace(/\/$/, "");
  const withinRoot = (path) => path === root || path.startsWith(`${root}${sep}`);
  const commonHeaders = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-cache",
  };
  const server = createServer(async (request, response) => {
    const send = (status, text, extra = {}) => {
      response.writeHead(status, {
        ...commonHeaders,
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": Buffer.byteLength(text),
        ...extra,
      });
      response.end(request.method === "HEAD" ? undefined : text);
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      send(405, "Method not allowed\n", { Allow: "GET, HEAD" });
      return;
    }
    let pathname;
    let query;
    try {
      const rawUrl = request.url ?? "/";
      if (!rawUrl.startsWith("/") || rawUrl.startsWith("//")) throw new Error("Invalid target");
      const queryAt = rawUrl.indexOf("?");
      query = queryAt === -1 ? "" : rawUrl.slice(queryAt);
      pathname = decodeURIComponent(queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt));
      if (
        !/^\/[A-Za-z0-9_./@-]*$/.test(pathname) ||
        pathname.includes("//") ||
        pathname.split("/").some((segment) => segment.startsWith("."))
      )
        throw new Error("Unsafe path");
    } catch {
      send(400, "Invalid path\n");
      return;
    }
    if (pathname === "/health" || pathname === "/health/") {
      send(200, "ok\n");
      return;
    }
    if (base && pathname !== base && !pathname.startsWith(`${base}/`)) {
      send(404, "Not found\n");
      return;
    }
    const relativePath = pathname.slice(base.length);
    if (relativePath === "/docs-runtime.json") {
      send(404, "Not found\n");
      return;
    }
    let file;
    try {
      let candidate = resolve(root, `.${relativePath || "/"}`);
      if (!withinRoot(candidate)) throw new Error("Outside build");
      if (!withinRoot(await realpath(candidate))) throw new Error("Outside build");
      const details = await lstat(candidate);
      if (details.isSymbolicLink() || (!details.isDirectory() && !details.isFile()))
        throw new Error("Not a regular build entry");
      if (details.isDirectory()) {
        if (!pathname.endsWith("/")) {
          send(308, "", { Location: `${encodeURI(pathname)}/${query}` });
          return;
        }
        candidate = resolve(candidate, "index.html");
      }
      const resolved = await realpath(candidate);
      if (!withinRoot(resolved)) throw new Error("Outside build");
      file = await open(
        candidate,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
      );
      const opened = await file.stat();
      if (!opened.isFile()) throw new Error("Not a file");
      const etag = `W/"${opened.size.toString(16)}-${opened.mtimeMs.toString(16)}-${opened.ctimeMs.toString(16)}"`;
      const cacheControl = relativePath.startsWith("/_astro/")
        ? "public, max-age=31536000, immutable"
        : "no-cache";
      if (matchesIfNoneMatch(request.headers["if-none-match"], etag)) {
        response.writeHead(304, { ...commonHeaders, "Cache-Control": cacheControl, ETag: etag });
        response.end();
        return;
      }
      response.writeHead(200, {
        ...commonHeaders,
        "Content-Type":
          contentTypes.get(extname(candidate).toLowerCase()) ?? "application/octet-stream",
        "Content-Length": opened.size,
        "Cache-Control": cacheControl,
        ETag: etag,
      });
      if (request.method === "HEAD") response.end();
      else await pipeline(file.createReadStream(), response);
    } catch {
      if (!response.headersSent) send(404, "Not found\n");
      else response.destroy();
    } finally {
      await file?.close().catch(() => undefined);
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}
