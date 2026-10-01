import assert from "node:assert/strict";
import { test } from "node:test";

import { createDocumentReadCache } from "../src/lib/document-read-cache.ts";

test("reuses one document download for sequential and concurrent chunks", async () => {
  const cache = createDocumentReadCache();
  let downloads = 0;
  const load = () => {
    downloads += 1;
    return Promise.resolve("<html>cached</html>");
  };

  const [first, second] = await Promise.all([
    cache.load("owner-a:doc-1", load),
    cache.load("owner-a:doc-1", load),
  ]);
  assert.equal(first, second);
  assert.equal(await cache.load("owner-a:doc-1", load), first);
  assert.equal(downloads, 1);

  assert.equal(await cache.load("owner-b:doc-1", load), first);
  assert.equal(downloads, 2);
});

test("expires, invalidates, and retries failed downloads", async () => {
  let time = 0;
  const cache = createDocumentReadCache(() => time, 60);
  let downloads = 0;
  const load = () => Promise.resolve(String(++downloads));

  assert.equal(await cache.load("owner:doc", load), "1");
  time = 61;
  assert.equal(await cache.load("owner:doc", load), "2");
  cache.invalidate("owner:doc");
  assert.equal(await cache.load("owner:doc", load), "3");

  await assert.rejects(cache.load("owner:failed", () => Promise.reject(new Error("offline"))));
  assert.equal(await cache.load("owner:failed", load), "4");
});
