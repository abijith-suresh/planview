import assert from "node:assert/strict";
import { test } from "node:test";

import { createCimdFetchHandler } from "../src/lib/cimd-fetch-handler.ts";

const secret = "a-32-byte-secret-for-cimd-fetch-tests";
const metadata = { url: "https://client.example/metadata.json", method: "GET", headers: {} };
const request = (body: unknown, authorization = `Bearer ${secret}`) =>
  new Request("https://app.example/api/internal/cimd-fetch", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("CIMD metadata fetch requires the shared secret before network access", async () => {
  let fetched = false;
  const handler = createCimdFetchHandler(async () => {
    fetched = true;
    return new Response("{}");
  }, secret);
  assert.equal((await handler({ request: request(metadata, "Bearer wrong") })).status, 401);
  assert.equal(fetched, false);
});

test("CIMD metadata fetch rejects unsafe request shapes and oversized bodies", async () => {
  const handler = createCimdFetchHandler(async () => new Response("{}"), secret);
  assert.equal(
    (await handler({ request: request({ ...metadata, url: "http://client.example" }) })).status,
    400
  );
  assert.equal(
    (await handler({ request: request({ ...metadata, headers: { cookie: "secret" } }) })).status,
    400
  );
  assert.equal(
    (await handler({ request: request({ ...metadata, padding: "a".repeat(3000) }) })).status,
    413
  );
});

test("CIMD metadata transport keeps allowlisted request and response headers", async () => {
  let passed: RequestInit | undefined;
  const handler = createCimdFetchHandler(async (_url, init) => {
    passed = init;
    return new Response("{}", {
      headers: { "content-type": "application/json", "set-cookie": "bad=value" },
    });
  }, secret);
  const response = await handler({
    request: request({ ...metadata, headers: { accept: "application/json" } }),
  });
  assert.equal(response.status, 200);
  assert.equal(new Headers(passed?.headers).get("accept"), "application/json");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("content-type"), "application/json");
});
