const fallback = "https://plansplease-docs-staging.up.railway.app";
export function documentationUrl(
  path = "",
  // biome-ignore lint/complexity/useLiteralKeys: Node environment declarations use an index signature.
  configured = process.env["PUBLIC_DOCS_URL"] ?? fallback
) {
  const url = new URL(configured);
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*$/.test(url.pathname) ||
    !/^[A-Za-z0-9_/-]*$/.test(path)
  )
    throw new Error("PUBLIC_DOCS_URL must be an HTTPS documentation base URL");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}/${path.replace(/^\/+|\/+$/g, "")}${path ? "/" : ""}`;
}
