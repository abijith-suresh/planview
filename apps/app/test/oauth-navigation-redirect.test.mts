import assert from "node:assert/strict";
import { test } from "node:test";

import { oauthNavigationRedirect } from "../src/lib/oauth-navigation-redirect.ts";

const authorizeUrl = "https://app.example/api/auth/oauth2/authorize?client_id=agent";
const consentUrl = "/mcp/consent?client_id=agent&sig=signed";

function instructionResponse() {
  return new Response(JSON.stringify({ redirect: true, url: consentUrl }), {
    headers: {
      "content-type": "application/json",
      "set-cookie": "session=abc; HttpOnly; Secure",
    },
  });
}

test("turns the OAuth authorization instruction into a browser redirect", async () => {
  const request = new Request(authorizeUrl, {
    headers: { "sec-fetch-mode": "navigate", accept: "text/html" },
  });
  const response = await oauthNavigationRedirect(request, instructionResponse());

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), consentUrl);
  assert.equal(response.headers.get("set-cookie"), "session=abc; HttpOnly; Secure");
  assert.equal(await response.text(), "");
});

test("keeps the public HTTPS origin when Railway forwards the request over HTTP", async () => {
  const request = new Request("http://app.example/api/auth/oauth2/authorize", {
    headers: { "sec-fetch-mode": "navigate", accept: "text/html" },
  });
  const response = await oauthNavigationRedirect(request, instructionResponse());

  assert.equal(response.headers.get("location"), consentUrl);
});

test("keeps JSON for OAuth requests made with fetch", async () => {
  const request = new Request(authorizeUrl, {
    headers: { "sec-fetch-mode": "cors", accept: "application/json" },
  });
  const upstream = instructionResponse();
  const response = await oauthNavigationRedirect(request, upstream);

  assert.equal(response, upstream);
  assert.deepEqual(await response.json(), { redirect: true, url: consentUrl });
});

test("leaves other auth endpoint responses alone", async () => {
  const request = new Request("https://app.example/api/auth/get-session", {
    headers: { "sec-fetch-mode": "navigate", accept: "text/html" },
  });
  const upstream = instructionResponse();
  assert.equal(await oauthNavigationRedirect(request, upstream), upstream);
});
