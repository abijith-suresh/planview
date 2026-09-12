import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BUNDLE_HEADER_BYTES,
  BundleEntryNotFoundError,
  createBundleHeader,
  encodeBundleManifest,
  findBundleEntry,
  InvalidBundleError,
  isBundleHeader,
  parseBundleHeader,
  parseBundleManifest,
  validateBundlePath,
} from "../dist/index.js";

const entries = [
  { path: "index.html", offset: 0, size: 12 },
  { path: "styles/app.css", offset: 12, size: 8 },
];

test("bundle headers and manifests round-trip", () => {
  const manifest = encodeBundleManifest(entries);
  const header = createBundleHeader(manifest);
  const parsedHeader = parseBundleHeader(Buffer.concat([header, Buffer.alloc(manifest.length)]));
  const parsed = parseBundleManifest(
    manifest,
    BUNDLE_HEADER_BYTES + parsedHeader.manifestBytes,
    BUNDLE_HEADER_BYTES + manifest.length + 20
  );

  assert.equal(isBundleHeader(header), true);
  assert.deepEqual(parsed.entries, entries);
  assert.equal(findBundleEntry(parsed, "styles/app.css").size, 8);
});

test("bundle paths reject traversal and platform separators", () => {
  for (const path of [
    "",
    "/index.html",
    "../index.html",
    "assets/../index.html",
    "assets\\app.js",
    "assets//app.js",
    "assets/./app.js",
  ]) {
    assert.throws(() => validateBundlePath(path), InvalidBundleError);
  }
});

test("bundle manifests reject duplicate, overlapping, and missing index entries", () => {
  assert.throws(
    () =>
      encodeBundleManifest([
        { path: "index.html", offset: 0, size: 1 },
        { path: "index.html", offset: 1, size: 1 },
      ]),
    InvalidBundleError
  );
  assert.throws(
    () =>
      encodeBundleManifest([
        { path: "index.html", offset: 0, size: 5 },
        { path: "x.js", offset: 4, size: 1 },
      ]),
    InvalidBundleError
  );
  assert.throws(
    () => encodeBundleManifest([{ path: "x.js", offset: 0, size: 1 }]),
    InvalidBundleError
  );
});

test("bundle entry lookup reports missing paths", () => {
  const manifestBytes = encodeBundleManifest(entries);
  const manifest = parseBundleManifest(
    manifestBytes,
    BUNDLE_HEADER_BYTES + manifestBytes.length,
    BUNDLE_HEADER_BYTES + manifestBytes.length + 20
  );
  assert.throws(() => findBundleEntry(manifest, "missing.js"), BundleEntryNotFoundError);
});
