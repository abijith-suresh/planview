import assert from "node:assert/strict";
import { test } from "node:test";

import { startGitHubSignIn } from "../src/lib/github-sign-in.ts";

const backendUrl = "https://auth-backend.example";
const quietLogger = { error() {} };

type Fetcher = typeof fetch;
type RecordedRequest = { url: RequestInfo | URL; options: RequestInit };

function createRequest(url: string, headers: HeadersInit = {}) {
  return new Request(url, { headers });
}

function createDependencies(
  fetcher: Fetcher,
  overrides: Partial<Parameters<typeof startGitHubSignIn>[1]> = {}
) {
  return {
    convexSiteUrl: backendUrl,
    railwayPublicDomain: undefined,
    fetcher,
    logger: quietLogger,
    ...overrides,
  };
}

function responseWithLocation(location = "https://github.com/login/oauth/authorize") {
  return new Response(JSON.stringify({ url: location }), {
    headers: { "content-type": "application/json" },
  });
}

test("uses the public forwarded host and first forwarded protocol behind an internal proxy", async () => {
  let upstream: RecordedRequest | undefined;
  const request = createRequest(
    "http://127.0.0.1:38343/auth/github?returnTo=%2Fcli%2Fauthorize%3Fstate%3Dabc%23ready",
    {
      host: "127.0.0.1:38343",
      "x-forwarded-host": "app.example, proxy.internal",
      "x-forwarded-proto": "https, http",
      cookie: "session=cli-test",
    }
  );

  const result = await startGitHubSignIn(
    request,
    createDependencies(async (url, options) => {
      upstream = { url, options: options ?? {} };
      return responseWithLocation();
    })
  );

  assert.ok(upstream);
  assert.equal(upstream.url, `${backendUrl}/api/auth/sign-in/social`);
  assert.equal(upstream.options.method, "POST");
  assert.equal(upstream.options.redirect, "manual");
  const upstreamHeaders = new Headers(upstream.options.headers);
  assert.equal(upstreamHeaders.get("origin"), "https://app.example");
  assert.equal(upstreamHeaders.get("host"), "auth-backend.example");
  assert.equal(upstreamHeaders.get("x-forwarded-host"), "app.example");
  assert.equal(upstreamHeaders.get("x-better-auth-forwarded-host"), "app.example");
  assert.equal(upstreamHeaders.get("x-forwarded-proto"), "https");
  assert.equal(upstreamHeaders.get("x-better-auth-forwarded-proto"), "https");
  assert.equal(upstreamHeaders.get("cookie"), "session=cli-test");
  assert.deepEqual(JSON.parse(String(upstream.options.body)), {
    provider: "github",
    callbackURL: "/cli/authorize?state=abc#ready",
  });
  assert.equal(result.status, 302);
  assert.equal(result.headers.get("location"), "https://github.com/login/oauth/authorize");
});

test("passes a signed OAuth query to Better Auth when starting agent sign-in", async () => {
  let upstream: RequestInit | undefined;
  await startGitHubSignIn(
    createRequest(
      "https://app.example/auth/github?oauth_query=client_id%3Dagent%26sig%3Dsignature"
    ),
    createDependencies(async (_url, options) => {
      upstream = options;
      return responseWithLocation();
    })
  );
  assert.ok(upstream);
  assert.deepEqual(JSON.parse(String(upstream.body)), {
    provider: "github",
    callbackURL: "/dashboard",
    oauth_query: "client_id=agent&sig=signature",
  });
});

test("prefers a configured Railway public domain and defaults it to HTTPS", async () => {
  let upstream: RequestInit | undefined;
  const result = await startGitHubSignIn(
    createRequest("http://router.railway.internal/auth/github", {
      host: "router.railway.internal",
      "x-forwarded-host": "app-staging.example",
      "x-forwarded-proto": "not-a-protocol",
    }),
    createDependencies(
      async (_url, options) => {
        upstream = options;
        return responseWithLocation();
      },
      { railwayPublicDomain: "app-staging.example" }
    )
  );

  assert.equal(result.status, 302);
  assert.ok(upstream);
  const headers = new Headers(upstream.headers);
  assert.equal(headers.get("origin"), "https://app-staging.example");
  assert.equal(headers.get("x-forwarded-host"), "app-staging.example");
  assert.equal(headers.get("x-forwarded-proto"), "https");
});

test("does not let an unrelated forwarded host override a public request host", async () => {
  let upstream: RequestInit | undefined;
  await startGitHubSignIn(
    createRequest("https://app.example/auth/github", {
      host: "app.example",
      "x-forwarded-host": "attacker.example",
    }),
    createDependencies(async (_url, options) => {
      upstream = options;
      return responseWithLocation();
    })
  );

  assert.ok(upstream);
  const headers = new Headers(upstream.headers);
  assert.equal(headers.get("origin"), "https://app.example");
  assert.equal(headers.get("x-forwarded-host"), "app.example");
});

test("accepts an absolute same-origin return URL and sends only its app path to Better Auth", async () => {
  let upstream: RequestInit | undefined;
  const returnTo = encodeURIComponent("https://app.example/cli/authorize?state=abc#callback");

  await startGitHubSignIn(
    createRequest(`https://app.example/auth/github?returnTo=${returnTo}`, {
      host: "app.example",
    }),
    createDependencies(async (_url, options) => {
      upstream = options;
      return responseWithLocation();
    })
  );

  assert.ok(upstream);
  assert.deepEqual(JSON.parse(String(upstream.body)), {
    provider: "github",
    callbackURL: "/cli/authorize?state=abc#callback",
  });
});

test("rejects a cross-origin return URL without contacting Better Auth", async () => {
  let called = false;
  const result = await startGitHubSignIn(
    createRequest(
      `https://app.example/auth/github?returnTo=${encodeURIComponent("//attacker.example/path")}`,
      { host: "app.example" }
    ),
    createDependencies(async () => {
      called = true;
      return responseWithLocation();
    })
  );

  assert.equal(result.status, 400);
  assert.deepEqual(await result.json(), {
    error: "The sign-in return URL must stay within this app.",
  });
  assert.equal(called, false);
});

test("maps a Better Auth error response to AUTH_START_FAILED", async () => {
  const result = await startGitHubSignIn(
    createRequest("https://app.example/auth/github", { host: "app.example" }),
    createDependencies(async () => new Response("provider unavailable", { status: 503 }))
  );

  assert.equal(result.status, 502);
  assert.deepEqual(await result.json(), {
    error: "GitHub sign-in could not be started.",
    code: "AUTH_START_FAILED",
  });
});

test("maps a network failure to AUTH_START_FAILED", async () => {
  const result = await startGitHubSignIn(
    createRequest("https://app.example/auth/github", { host: "app.example" }),
    createDependencies(async () => {
      throw new Error("connection refused");
    })
  );

  assert.equal(result.status, 502);
  assert.deepEqual(await result.json(), {
    error: "GitHub sign-in could not be started.",
    code: "AUTH_START_FAILED",
  });
});

test("prefers Better Auth's Location header and forwards its cookie", async () => {
  const result = await startGitHubSignIn(
    createRequest("https://app.example/auth/github", { host: "app.example" }),
    createDependencies(
      async () =>
        new Response(JSON.stringify({ url: "https://github.com/from-json" }), {
          headers: {
            "content-type": "application/json",
            location: "https://github.com/from-header",
            "set-cookie": "better-auth.state=abc; Path=/; HttpOnly; Secure",
          },
        })
    )
  );

  assert.equal(result.status, 302);
  assert.equal(result.headers.get("location"), "https://github.com/from-header");
  assert.equal(result.headers.get("set-cookie"), "better-auth.state=abc; Path=/; HttpOnly; Secure");
});

test("maps a successful response without a redirect to AUTH_REDIRECT_MISSING", async () => {
  const result = await startGitHubSignIn(
    createRequest("https://app.example/auth/github", { host: "app.example" }),
    createDependencies(async () => Response.json({}))
  );

  assert.equal(result.status, 502);
  assert.deepEqual(await result.json(), {
    error: "GitHub sign-in did not return a redirect.",
    code: "AUTH_REDIRECT_MISSING",
  });
});

test("returns the unconfigured response without contacting Better Auth", async () => {
  let called = false;
  const result = await startGitHubSignIn(
    createRequest("https://app.example/auth/github", { host: "app.example" }),
    createDependencies(
      async () => {
        called = true;
        return responseWithLocation();
      },
      { convexSiteUrl: undefined }
    )
  );

  assert.equal(result.status, 503);
  assert.deepEqual(await result.json(), {
    error: "Authentication is not configured yet.",
    code: "AUTH_NOT_CONFIGURED",
  });
  assert.equal(called, false);
});
