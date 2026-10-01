export function createDocumentReadCache(now = Date.now, ttlMs = 60_000) {
  let entry: { key: string; expiresAt: number; value: Promise<string> } | undefined;

  return {
    load(key: string, loader: () => Promise<string>): Promise<string> {
      if (entry?.key === key && entry.expiresAt > now()) return entry.value;

      const value = Promise.resolve().then(loader);
      entry = { key, expiresAt: now() + ttlMs, value };
      void value.catch(() => {
        if (entry?.value === value) entry = undefined;
      });
      return value;
    },
    invalidate(key: string) {
      if (entry?.key === key) entry = undefined;
    },
  };
}
