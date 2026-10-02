const defaults = {
  PUBLIC_APP_URL: "https://plansplease-app-staging.up.railway.app",
  PUBLIC_SITE_URL: "https://plansplease-site-staging.up.railway.app",
  PUBLIC_DOCS_URL: "https://plansplease-docs-staging.up.railway.app",
} as const;

type PublicEnvironment = { [key: string]: string | undefined };

export function readPublicUrls(environment: PublicEnvironment) {
  const normalize = (key: keyof typeof defaults, rootOnly = false) => {
    const url = new URL(environment[key] ?? defaults[key]);
    if (
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        )) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*$/.test(url.pathname) ||
      (rootOnly && url.pathname !== "/")
    )
      throw new Error(`${key} must be an HTTPS URL without credentials, query, or fragment`);
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}/`;
  };
  const docsUrl = normalize("PUBLIC_DOCS_URL");
  return {
    appUrl: normalize("PUBLIC_APP_URL", true),
    siteUrl: normalize("PUBLIC_SITE_URL"),
    docsUrl,
    docsOrigin: new URL(docsUrl).origin,
    docsBasePath: new URL(docsUrl).pathname,
  };
}
