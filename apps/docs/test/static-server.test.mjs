import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createStaticDocsServer } from "../server/static-server.mjs";

const rawRequest = (port, path, method = "GET") =>
  new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString(),
        })
      );
    });
    req.on("error", reject);
    req.end();
  });

test("static docs serving preserves prefixes, MIME, HEAD, and safe cache behavior", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "plansplease-docs-server-"));
  const root = join(fixture, "dist");
  await mkdir(join(root, "guide"), { recursive: true });
  await mkdir(join(root, "_astro"));
  await mkdir(join(root, "pagefind"));
  await writeFile(join(root, "index.html"), "<h1>Docs</h1>");
  await writeFile(join(root, "guide", "index.html"), "<h1>Guide</h1>");
  await writeFile(join(root, "_astro", "app.hash.js"), "export const value=1;");
  await writeFile(join(root, "pagefind", "pagefind.wasm"), Buffer.from([0, 97, 115, 109]));
  await writeFile(join(root, "docs-runtime.json"), '{"basePath":"/manual/"}');
  const server = await createStaticDocsServer({ rootDirectory: root, basePath: "/manual/" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(fixture, { recursive: true, force: true });
  });
  const port = server.address().port;
  assert.equal((await rawRequest(port, "/health")).body, "ok\n");
  const headHealth = await rawRequest(port, "/health", "HEAD");
  assert.equal(headHealth.status, 200);
  assert.equal(headHealth.body, "");
  assert.equal((await rawRequest(port, "/health", "POST")).status, 405);
  const redirect = await rawRequest(port, "/manual/guide?from=nav");
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.location, "/manual/guide/?from=nav");
  assert.equal((await rawRequest(port, "/manual/")).body, "<h1>Docs</h1>");
  assert.equal((await rawRequest(port, "/guide/")).status, 404);
  const page = await rawRequest(port, "/manual/guide/", "HEAD");
  assert.equal(page.body, "");
  assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(page.headers["content-length"], String(Buffer.byteLength("<h1>Guide</h1>")));
  assert.equal(page.headers["cache-control"], "no-cache");
  const script = await rawRequest(port, "/manual/_astro/app.hash.js");
  assert.equal(script.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(script.headers["x-content-type-options"], "nosniff");
  assert.match(script.headers["cache-control"], /immutable/);
  assert.equal(
    (await rawRequest(port, "/manual/pagefind/pagefind.wasm")).headers["content-type"],
    "application/wasm"
  );
  assert.equal((await rawRequest(port, "/manual/docs-runtime.json")).status, 404);
  assert.equal((await rawRequest(port, "/manual/missing/")).status, 404);
  for (const path of [
    "/../secret",
    "/manual/%2e%2e/secret",
    "/%2f%2fguide",
    "/manual/%5csecret",
    "/manual/%00",
    "/manual/%",
    "/manual/.env",
  ]) {
    const response = await rawRequest(port, path);
    assert.equal(response.status, 400, path);
    assert.equal(response.headers.location, undefined, path);
  }
  if (process.platform !== "win32") {
    await mkdir(join(fixture, "outside"));
    await writeFile(join(fixture, "outside", "secret.html"), "private fixture");
    await symlink(join(fixture, "outside"), join(root, "escape"));
    assert.equal((await rawRequest(port, "/manual/escape/secret.html")).status, 404);
    assert.equal((await rawRequest(port, "/manual/escape")).status, 404);
  }
});
