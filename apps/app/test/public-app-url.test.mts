import assert from "node:assert/strict";
import { test } from "node:test";
import { readAppOrigin } from "../src/lib/public-app-url.ts";

test("app social metadata uses its configured public origin", () => {
  assert.equal(readAppOrigin(), "https://plansplease-app-staging.up.railway.app");
  assert.equal(readAppOrigin("https://app.example.com/"), "https://app.example.com");
  assert.equal(readAppOrigin("http://localhost:3000"), "http://localhost:3000");
  assert.equal(readAppOrigin("http://[::1]:3000"), "http://[::1]:3000");
  for (const value of [
    "javascript:alert(1)",
    "http://app.example.com",
    "https://user:secret@app.example.com",
    "https://app.example.com/private",
    "https://app.example.com/?token=secret",
    "https://app.example.com/#private",
  ])
    assert.throws(() => readAppOrigin(value), Error, value);
});
