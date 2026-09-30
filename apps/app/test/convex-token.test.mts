import assert from "node:assert/strict";
import { test } from "node:test";

import { ConvexTokenServiceError, fetchConvexToken } from "../src/lib/convex-token.ts";

const siteUrl = "https://auth.example";

test("forwards the session cookie and returns a Convex token", async () => {
  const token = await fetchConvexToken(
    siteUrl,
    new Headers({ cookie: "session=test-session" }),
    async (url, options) => {
      assert.equal(url, `${siteUrl}/api/auth/convex/token`);
      assert.equal(new Headers(options?.headers).get("cookie"), "session=test-session");
      assert.equal(new Headers(options?.headers).get("host"), "auth.example");
      return Response.json({ token: "signed-test-token" });
    }
  );
  assert.equal(token, "signed-test-token");
});

test("distinguishes an absent session from a missing token endpoint", async () => {
  assert.equal(
    await fetchConvexToken(siteUrl, new Headers(), async () => new Response(null, { status: 401 })),
    null
  );
  await assert.rejects(
    fetchConvexToken(siteUrl, new Headers(), async () => new Response(null, { status: 404 })),
    (error) => error instanceof ConvexTokenServiceError && error.status === 404
  );
  await assert.rejects(
    fetchConvexToken(siteUrl, new Headers(), async () => new Response("invalid JSON")),
    (error) => error instanceof ConvexTokenServiceError && error.status === 200
  );
});
