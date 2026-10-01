import assert from "node:assert/strict";
import { test } from "node:test";
import { cloudBundleContentType, cloudBundleEntry, packCloudBundle, parseCloudBundle } from "../src/lib/cloud-bundle.ts";
import { bundleEntryUrl, createBundleCapability, verifyBundleCapability } from "../src/lib/bundle-capability.ts";
import { createBundleAssetHandler } from "../src/lib/bundle-asset-handler.ts";
import { createBundleReadCache, readBoundedBundle } from "../src/lib/bundle-read-cache.ts";

const secret = "independent-test-secret-of-at-least-32-bytes";
const now = 1000;
const claims = { documentId: "doc-a", ownerId: "owner-a", storageProvider: "uploadthing", storageKey: "private-locator" };
const files = [
  { path: "index.html", content: '<link rel="stylesheet" href="styles/page.css"><script type="module" src="scripts/main.mjs"></script><h1>Plan</h1>' },
  { path: "styles/page.css", content: "h1{color:blue}" },
  { path: "scripts/main.mjs", content: 'import {value} from "./value.mjs"; document.body.dataset.value=value;' },
  { path: "scripts/value.mjs", content: 'export const value="works";' },
];

test("cloud bundles preserve local format and nested CSS/JS bytes", () => {
  const bundle = parseCloudBundle(packCloudBundle(files));
  assert.equal(new TextDecoder().decode(cloudBundleEntry(bundle, "scripts/main.mjs").bytes), files[2]!.content);
  assert.equal(cloudBundleEntry(bundle, "styles/page.css").contentType, "text/css");
  assert.throws(() => cloudBundleEntry(bundle, "../private"));
});

test("bundle validation rejects traversal, aliases, duplicate entries, missing index and unsupported file types", () => {
  for (const path of ["../secret.js", "a/../b.js", "a\\b.js", "/a.js", "%2e%2e/a.js", "a?x.js", "a#x.js", "C:a.js", "source.exe"]) {
    assert.throws(() => packCloudBundle([files[0]!, { path, content: "bad" }]));
  }
  assert.throws(() => packCloudBundle([files[1]!]));
  assert.throws(() => packCloudBundle([files[0]!, files[0]!]));
  assert.throws(() => packCloudBundle(Array.from({ length: 513 }, (_, i) => ({ path: `${i}.js`, content: "" }))));
  assert.throws(() => packCloudBundle([{ path: "index.html", content: "a".repeat(8 * 1024 * 1024) }]), /8 MiB/);
  assert.throws(() => parseCloudBundle(new Uint8Array(8 * 1024 * 1024 + 1)), /8 MiB/);
  const truncated = packCloudBundle(files).slice(0, 16);
  assert.throws(() => parseCloudBundle(truncated));
});

test("opaque capabilities are randomized, hide locators and bind document, secret and expiry", () => {
  const token = createBundleCapability(secret, claims, now);
  assert.notEqual(token, createBundleCapability(secret, claims, now));
  assert.ok(!Buffer.from(token, "base64url").includes(Buffer.from(claims.storageKey)));
  assert.equal(verifyBundleCapability(secret, claims.documentId, token, now)?.ownerId, claims.ownerId);
  for (const [id, cap, signingSecret, time] of [
    ["doc-b", token, secret, now], [claims.documentId, `${token.slice(0,-2)}aa`, secret, now],
    [claims.documentId, token, `${secret}wrong`, now], [claims.documentId, token, secret, now + 300_000],
    [claims.documentId, "x".repeat(4097), secret, now],
  ] as const) assert.equal(verifyBundleCapability(signingSecret, id, cap, time), null);
  assert.throws(() => createBundleCapability("short", claims, now));
  assert.throws(() => bundleEntryUrl("https://user:secret@app.test", claims.documentId, token));
  assert.equal(new URL(bundleEntryUrl("https://app.test", claims.documentId, token)).pathname.endsWith("/index.html"), true);
});

test("asset reads verify capability before metadata and authorize every request before cached bytes", async () => {
  let backendReads = 0, byteReads = 0;
  let active = true;
  const handler = createBundleAssetHandler({
    secret: () => secret, now: () => now,
    getDocument: async () => { backendReads += 1; return active ? { contentType: cloudBundleContentType, storageProvider: claims.storageProvider, storageKey: claims.storageKey } : null; },
    load: async () => { byteReads += 1; return parseCloudBundle(packCloudBundle(files)); },
  });
  const token = createBundleCapability(secret, claims, now);
  const event = { request: new Request("https://app.test/asset"), params: { id: claims.documentId, cap: token, path: "styles/page.css" } };
  assert.equal((await handler({ ...event, params: { ...event.params, cap: "guess" } })).status, 404);
  assert.equal((await handler({ ...event, params: { ...event.params, id: "doc-b" } })).status, 404);
  assert.equal(backendReads, 0);
  const response = await handler(event);
  assert.equal(await response.text(), files[1]!.content);
  assert.equal(response.headers.get("content-type"), "text/css; charset=utf-8");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.ok(!response.headers.get("content-security-policy")!.includes("allow-same-origin"));
  active = false;
  assert.equal((await handler(event)).status, 404);
  assert.equal(backendReads, 2);
  assert.equal(byteReads, 1);
});

test("asset reads reject locator changes, deletion, bad paths, and hide provider failures", async () => {
  const token = createBundleCapability(secret, claims, now);
  const event = { request: new Request("https://app.test/asset"), params: { id: claims.documentId, cap: token, path: "index.html" } };
  for (const document of [
    { contentType: cloudBundleContentType, storageProvider: "uploadthing", storageKey: "another-file" },
    { contentType: cloudBundleContentType, storageProvider: "uploadthing", storageKey: claims.storageKey, deletionRequestedAt: 1 },
  ]) {
    const handler = createBundleAssetHandler({ secret: () => secret, now: () => now, getDocument: async () => document, load: async () => assert.fail("must not fetch") });
    assert.equal((await handler(event)).status, 404);
  }
  const invalid = createBundleAssetHandler({ secret: () => secret, now: () => now, getDocument: async () => assert.fail("must reject path"), load: async () => assert.fail("must not fetch") });
  assert.equal((await invalid({ ...event, params: { ...event.params, path: "../secret.js" } })).status, 404);
  const failed = createBundleAssetHandler({ secret: () => secret, now: () => now, getDocument: async () => { throw new Error("private-locator"); }, load: async () => assert.fail("must not fetch") });
  assert.equal(await (await failed(event)).text(), "Not found");
});

test("bundle fetches cap actual streamed bytes even when Content-Length lies", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); },
    cancel() { cancelled = true; },
  }), { headers: { "content-length": "1" } });
  await assert.rejects(readBoundedBundle(response), /8 MiB/);
  assert.equal(cancelled, true);
});

test("cache bounds in-flight loads, removes failures, expires entries and reuses one bundle", async () => {
  let time = 0, reads = 0;
  const cache = createBundleReadCache(() => time);
  const bytes = packCloudBundle(files);
  const loader = async () => { reads += 1; return bytes; };
  assert.equal(await cache.load("a", loader), await cache.load("a", loader));
  assert.equal(reads, 1);
  time = 60_000;
  await cache.load("a", loader);
  assert.equal(reads, 2);
  let release!: (bytes: Uint8Array) => void;
  const pending = new Promise<Uint8Array>((resolve) => { release = resolve; });
  const first = cache.load("b", () => pending);
  const second = cache.load("c", () => pending);
  await assert.rejects(cache.load("d", loader), /busy/);
  release(bytes); await first; await second;
  await assert.rejects(cache.load("bad", async () => new Uint8Array()), /bundle/i);
  await cache.load("bad", loader);
});
