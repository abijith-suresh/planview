import assert from "node:assert/strict";
import { test } from "node:test";

import { documentPreviewResponse } from "../src/lib/document-preview.ts";
import { readPreviewDocument } from "../src/lib/document-preview-client.ts";

const limit = 8 * 1024 * 1024;

test("preview escapes title and storage URL without allowing script or markup injection", async () => {
  const response = documentPreviewResponse(
    "https://cdn.example/file?value=</script><script>alert(1)</script>",
    'A "><script>alert(2)</script> & document'
  );
  const html = await response.text();
  assert.equal((html.match(/<script>/g) ?? []).length, 1);
  assert.ok(html.includes("&lt;script&gt;alert(2)&lt;/script&gt; &amp; document"));
  assert.ok(!html.includes("allow-same-origin"));
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.match(response.headers.get("content-security-policy")!, /frame-src blob: https:/);
  assert.match(response.headers.get("content-security-policy")!, /sandbox allow-scripts/);
  assert.match(response.headers.get("content-security-policy")!, /script-src 'unsafe-inline'/);
});

test("preview rejects unsafe read origins", () => {
  for (const url of [
    "http://cdn.example/file",
    "javascript:alert(1)",
    "https://user:secret@cdn.example/file",
  ]) {
    assert.throws(() => documentPreviewResponse(url));
  }
});

test("browser fetch omits credentials and referrer and overrides attachment MIME for HTML rendering", async (t) => {
  const expected = '<h1>Document</h1><script>document.body.dataset.rendered="yes";</script>';
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    assert.equal(init.credentials, "omit");
    assert.equal(init.mode, "cors");
    assert.equal(init.referrerPolicy, "no-referrer");
    assert.ok(init.signal);
    return new Response(expected, {
      headers: { "content-type": "application/octet-stream", "content-disposition": "attachment" },
    });
  });
  const blob = await readPreviewDocument(
    "https://cdn.example/file",
    limit,
    new AbortController().signal
  );
  assert.equal(blob.type, "text/html;charset=utf-8");
  assert.equal(await blob.text(), expected);
});

test("browser enforces actual streamed bytes when upstream content length is missing or lies", async (t) => {
  for (const contentLength of [undefined, "1"]) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(limit));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const mock = t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(stream, {
          headers: contentLength ? { "content-length": contentLength } : {},
        })
    );
    await assert.rejects(
      readPreviewDocument("https://cdn.example/file", limit, new AbortController().signal),
      /8 MiB/
    );
    assert.equal(cancelled, true);
    mock.mock.restore();
  }
});

test("browser rejects declared oversize responses before reading and cancels unavailable bodies", async (t) => {
  for (const status of [200, 404]) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const mock = t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(stream, {
          status,
          headers: { "content-length": String(limit + 1) },
        })
    );
    await assert.rejects(
      readPreviewDocument("https://cdn.example/file", limit, new AbortController().signal),
      status === 200 ? /8 MiB/ : /unavailable/
    );
    assert.equal(cancelled, true);
    mock.mock.restore();
  }
});

test("browser cancels reading on an aborted request", async (t) => {
  const controller = new AbortController();
  controller.abort();
  let cancelled = false;
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        })
      )
  );
  await assert.rejects(readPreviewDocument("https://cdn.example/file", limit, controller.signal), {
    name: "AbortError",
  });
  assert.equal(cancelled, true);
});
