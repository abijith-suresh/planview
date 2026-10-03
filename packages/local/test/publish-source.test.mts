import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { preparePublishSource } from "../dist/publish-source.js";

test("preparation rejects a child directory replaced while collecting entries", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "planview-changing-folder-"));
  const assets = join(root, "assets");
  await fs.mkdir(assets);
  await fs.writeFile(join(root, "index.html"), "<h1>Page</h1>");
  await fs.writeFile(join(assets, "style.css"), "h1{color:red}");
  const originalRead = fs.readdir;
  const mock = t.mock.method(
    fs,
    "readdir",
    async (path: Parameters<typeof fs.readdir>[0], options: unknown) => {
      if (String(path) === assets) {
        await fs.rename(assets, join(root, "previous-assets"));
        await fs.mkdir(assets);
        await fs.writeFile(join(assets, "style.css"), "h1{color:blue}");
      }
      return originalRead(path, options as { withFileTypes: true });
    }
  );
  syncBuiltinESMExports();
  try {
    await assert.rejects(preparePublishSource(root), /changed during preparation/);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("preparation enforces total cloud byte limit including manifest and cleanup removes its temporary object", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "planview-bounded-folder-"));
  try {
    await fs.writeFile(join(root, "index.html"), "<h1>Page</h1>");
    await assert.rejects(preparePublishSource(root, { maxBytes: 20 }), /including its manifest/);
    const prepared = await preparePublishSource(root, { maxBytes: 1024 });
    assert.ok((await fs.stat(prepared.sourcePath)).isFile());
    await prepared.cleanup();
    await assert.rejects(fs.stat(prepared.sourcePath), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
