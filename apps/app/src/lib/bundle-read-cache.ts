import { parseCloudBundle, cloudBundleMaxBytes, type CloudBundle } from "./cloud-bundle.ts";

// Keep only two loaded objects and two fetches in progress. Entry requests still
// authorize metadata before touching this cache. Failed/expired loads are removed.
export function createBundleReadCache(now = Date.now) {
  const entries = new Map<string, { value: Promise<CloudBundle>; expiresAt: number }>();
  let loading = 0;
  const maxEntries = 2;
  return {
    async load(key: string, loader: () => Promise<Uint8Array>): Promise<CloudBundle> {
      const existing = entries.get(key);
      if (existing && existing.expiresAt > now()) return existing.value;
      if (existing) entries.delete(key);
      if (loading >= maxEntries) throw new Error("Bundle delivery is busy. Try again.");
      if (entries.size >= maxEntries) entries.delete(entries.keys().next().value!);
      loading += 1;
      const value = Promise.resolve()
        .then(loader)
        .then(parseCloudBundle)
        .finally(() => {
          loading -= 1;
        });
      entries.set(key, { value, expiresAt: now() + 60_000 });
      void value.catch(() => {
        if (entries.get(key)?.value === value) entries.delete(key);
      });
      return value;
    },
  };
}

export async function readBoundedBundle(response: Response): Promise<Uint8Array> {
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Bundle content is unavailable");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (Number(response.headers.get("content-length")) > cloudBundleMaxBytes)
      throw new Error("Bundle content exceeds 8 MiB");
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > cloudBundleMaxBytes) throw new Error("Bundle content exceeds 8 MiB");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export const serverBundleReadCache = createBundleReadCache();
export const bundleCacheKey = (provider: string, key: string) => JSON.stringify([provider, key]);
