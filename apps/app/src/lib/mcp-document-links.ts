export function presentMcpUpload(id: string, siteUrl: string) {
  const url = new URL(`/api/documents/${encodeURIComponent(id)}`, siteUrl);
  return { id, url: url.href };
}
