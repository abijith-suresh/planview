import { verifyBundleCapability, type BundleCapability } from "./bundle-capability.ts";
import {
  cloudBundleContentType,
  cloudBundleEntry,
  cloudBundleMime,
  type CloudBundle,
} from "./cloud-bundle.ts";

export const bundleResponseHeaders = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "X-Content-Type-Options": "nosniff",
  "Access-Control-Allow-Origin": "*",
  "Content-Disposition": "inline",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=()",
};

export function createBundleAssetHandler(dependencies: {
  secret(): string;
  getDocument(claims: BundleCapability): Promise<{
    contentType: string;
    storageProvider?: string;
    storageKey?: string;
    deletionRequestedAt?: number;
  } | null>;
  load(claims: BundleCapability): Promise<CloudBundle>;
  now?: () => number;
}) {
  return async ({
    request,
    params,
  }: {
    request: Request;
    params: { id: string; cap: string; path: string };
  }) => {
    const notFound = () =>
      new Response("Not found", { status: 404, headers: bundleResponseHeaders });
    try {
      const claims = verifyBundleCapability(
        dependencies.secret(),
        params.id,
        params.cap,
        dependencies.now?.()
      );
      if (!claims) return notFound();
      cloudBundleMime(params.path);
      const document = await dependencies.getDocument(claims);
      if (
        !document ||
        document.deletionRequestedAt !== undefined ||
        document.contentType !== cloudBundleContentType ||
        document.storageProvider !== claims.storageProvider ||
        document.storageKey !== claims.storageKey
      )
        return notFound();
      return bundleAssetResponse(await dependencies.load(claims), params.path, request);
    } catch {
      return notFound();
    }
  };
}

export function bundleAssetResponse(bundle: CloudBundle, path: string, request: Request) {
  const { bytes, contentType } = cloudBundleEntry(bundle, path);
  const local = new URL(request.url);
  const localSources =
    local.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(local.hostname)
      ? ` ${local.origin}`
      : "";
  const headers = new Headers(bundleResponseHeaders);
  headers.set(
    "Content-Type",
    `${contentType}${contentType.startsWith("text/") ? "; charset=utf-8" : ""}`
  );
  headers.set(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "base-uri 'none'",
      "object-src 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "sandbox allow-scripts allow-modals allow-popups",
      `script-src 'unsafe-inline' https: blob:${localSources}`,
      `style-src 'unsafe-inline' https:${localSources}`,
      `img-src data: blob: https:${localSources}`,
      `font-src data: blob: https:${localSources}`,
      `media-src data: blob: https:${localSources}`,
      `connect-src https:${localSources}`,
      `worker-src blob: https:${localSources}`,
      `frame-src https:${localSources}`,
    ].join("; ")
  );
  return new Response(new Uint8Array(bytes), { headers });
}
