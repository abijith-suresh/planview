export function readSiteOrigin(value?: string): string {
  const url = new URL(value ?? "https://plansplease-site-staging.up.railway.app");
  const localHttp =
    url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !localHttp) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("PUBLIC_SITE_URL must be an HTTPS origin, or a local HTTP origin");
  return url.origin;
}
