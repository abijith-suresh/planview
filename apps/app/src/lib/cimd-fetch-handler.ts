import { timingSafeEqual } from "node:crypto";

type MetadataFetch = (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>;

const maxBodyBytes = 64 * 1024;
const allowedHeaders = new Set(["accept", "if-none-match", "if-modified-since"]);
const returnedHeaders = new Set([
  "cache-control",
  "content-type",
  "etag",
  "expires",
  "last-modified",
  "vary",
]);

const matchesSecret = (authorization: string | null, secret: string | undefined) => {
  if (!secret || Buffer.byteLength(secret) < 32 || !authorization?.startsWith("Bearer ")) {
    return false;
  }
  const presented = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(secret);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
};

const readBounded = async (response: Response) => {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBodyBytes) throw new Error("CIMD metadata response too large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

export const createCimdFetchHandler =
  (fetchMetadata: MetadataFetch, secret: string | undefined) =>
  async ({ request }: { request: Request }) => {
    if (!matchesSecret(request.headers.get("authorization"), secret)) {
      return new Response(null, { status: 401, headers: { "Cache-Control": "no-store" } });
    }
    const length = Number(request.headers.get("content-length") ?? "0");
    if (!Number.isSafeInteger(length) || length > 2048) {
      return new Response(null, { status: 413 });
    }
    let input: unknown;
    try {
      if (!request.body) return new Response(null, { status: 400 });
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2048) {
            await reader.cancel();
            return new Response(null, { status: 413 });
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      input = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return new Response(null, { status: 400 });
    }
    if (!input || typeof input !== "object") return new Response(null, { status: 400 });
    const { url, method, headers } = input as Record<string, unknown>;
    if (
      typeof url !== "string" ||
      url.length > 2048 ||
      (method !== "GET" && method !== "HEAD") ||
      !headers ||
      typeof headers !== "object" ||
      Array.isArray(headers)
    ) {
      return new Response(null, { status: 400 });
    }
    let target: URL;
    try {
      target = new URL(url);
      if (target.protocol !== "https:" || target.username || target.password || target.hash) {
        return new Response(null, { status: 400 });
      }
    } catch {
      return new Response(null, { status: 400 });
    }
    const forwarded = new Headers();
    for (const [name, value] of Object.entries(headers)) {
      if (!allowedHeaders.has(name.toLowerCase()) || typeof value !== "string") {
        return new Response(null, { status: 400 });
      }
      forwarded.set(name, value);
    }
    try {
      const response = await fetchMetadata(target, {
        method,
        headers: forwarded,
        redirect: "error",
        signal: AbortSignal.timeout(6_000),
      });
      const selectedHeaders = new Headers();
      for (const [name, value] of response.headers) {
        if (returnedHeaders.has(name.toLowerCase())) selectedHeaders.set(name, value);
      }
      const body =
        method === "HEAD" || response.status === 304 ? null : await readBounded(response);
      return new Response(body, { status: response.status, headers: selectedHeaders });
    } catch {
      return new Response(null, { status: 502, headers: { "Cache-Control": "no-store" } });
    }
  };
