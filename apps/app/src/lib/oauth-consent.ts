export function consentRedirectUrl(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  if ("redirect_uri" in data && typeof data.redirect_uri === "string") {
    return data.redirect_uri;
  }
  if ("redirect" in data && data.redirect === true && "url" in data) {
    return typeof data.url === "string" ? data.url : undefined;
  }
  return undefined;
}
