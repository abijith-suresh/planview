import assert from "node:assert/strict";
import { test } from "node:test";

import { logAuthResponse } from "../src/lib/auth-diagnostics.ts";

test("auth diagnostics record session state without credentials or OAuth codes", async () => {
  const previousFlag = process.env["AUTH_DIAGNOSTICS"];
  const previousInfo = console.info;
  const entries: string[] = [];
  process.env["AUTH_DIAGNOSTICS"] = "true";
  console.info = (...values) => entries.push(values.join(" "));

  try {
    const request = new Request("https://app.example/api/auth/callback/github?code=secret-code", {
      headers: { cookie: "better-auth.session_token=secret-cookie" },
    });
    const headers = new Headers({ location: "/dashboard?state=secret-state" });
    headers.append("set-cookie", "better-auth.session_token=secret-session; Path=/; Secure");
    await logAuthResponse(request, new Response(null, { status: 302, headers }));

    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.ok(entry);
    assert.match(entry, /"requestHasSessionCookie":true/);
    assert.match(entry, /"setCookieNames":\["better-auth.session_token"\]/);
    assert.match(entry, /"redirect":"https:\/\/app.example\/dashboard"/);
    assert.doesNotMatch(entry, /secret-/);
  } finally {
    console.info = previousInfo;
    if (previousFlag === undefined) delete process.env["AUTH_DIAGNOSTICS"];
    else process.env["AUTH_DIAGNOSTICS"] = previousFlag;
  }
});
