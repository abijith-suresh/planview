import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cliCredentialFromRequest,
  hashCliCredential,
  issueCliCredential,
} from "../src/lib/cli-credential.ts";

test("issues a random upload credential without returning a web session token", () => {
  const first = issueCliCredential();
  const second = issueCliCredential();
  assert.match(first.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.secret, second.secret);
  assert.equal(first.tokenHash, hashCliCredential(`planview_cli_${first.secret}`));
  assert.equal(first.tokenHash.length, 64);
});

test("extracts only CLI bearer credentials for the upload route", () => {
  const request = (authorization: string) =>
    new Request("https://cloud.example/api/documents/upload", {
      headers: { Authorization: authorization },
    });
  const token = "planview_cli_valid-token";
  assert.deepEqual(cliCredentialFromRequest(request(`Bearer ${token}`)), {
    tokenHash: hashCliCredential(token),
  });
  assert.equal(cliCredentialFromRequest(request("Bearer web-session")), null);
  assert.equal(cliCredentialFromRequest(request("Bearer planview_cli_invalid.token")), null);
});
