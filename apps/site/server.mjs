import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = resolve(fileURLToPath(new URL("./dist/", import.meta.url)));
const port = Number.parseInt(process.env.PORT ?? "4321", 10);

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".xml": "application/xml; charset=utf-8",
};

const send = (response, status, body, headers = {}) => {
  response.writeHead(status, headers);
  response.end(body);
};

const resolvePublicFile = async (pathname) => {
  let decodedPath;

  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const candidate = resolve(rootDirectory, `.${decodedPath}`);

  if (candidate !== rootDirectory && !candidate.startsWith(`${rootDirectory}${sep}`)) {
    return null;
  }

  try {
    const details = await stat(candidate);
    if (details.isFile()) return candidate;
    if (!details.isDirectory()) return null;
  } catch {
    return null;
  }

  const indexFile = resolve(candidate, "index.html");

  try {
    await access(indexFile);
    return indexFile;
  } catch {
    return null;
  }
};

const server = createServer(async (request, response) => {
  if (request.url === "/health" || request.url === "/health/") {
    send(response, 200, "ok\n", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    send(response, 405, "Method not allowed\n", { Allow: "GET, HEAD" });
    return;
  }

  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const filePath = await resolvePublicFile(pathname);

  if (!filePath) {
    send(response, 404, "Not found\n", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }

  const extension = extname(filePath).toLowerCase();
  const cacheControl = extension === ".html" ? "no-cache" : "public, max-age=31536000, immutable";
  const headers = {
    "Cache-Control": cacheControl,
    "Content-Type": contentTypes[extension] ?? "application/octet-stream",
  };

  if (request.method === "HEAD") {
    send(response, 200, null, headers);
    return;
  }

  response.writeHead(200, headers);
  createReadStream(filePath).pipe(response);
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`plansplease site listening on ${port}\n`);
});
