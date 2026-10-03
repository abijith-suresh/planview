export const docsUrl = (path = "") => {
  const configured = import.meta.env["VITE_PUBLIC_DOCS_URL"]?.trim();
  const base = new URL(configured || "https://plansplease-docs-staging.up.railway.app/");
  if (
    base.protocol !== "https:" &&
    !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
  ) {
    throw new Error("VITE_PUBLIC_DOCS_URL must use HTTPS or local HTTP.");
  }
  if (base.username || base.password || base.search || base.hash) {
    throw new Error("VITE_PUBLIC_DOCS_URL must not include credentials, a query or a fragment.");
  }
  base.pathname = `${base.pathname.replace(/\/$/, "")}/`;
  return new URL(path, base).href;
};
