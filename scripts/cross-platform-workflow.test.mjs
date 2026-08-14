import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const workflow = readFileSync(resolve(".github", "workflows", "ci.yml"), "utf8");
const smoke = workflow.slice(workflow.indexOf("  cross-platform-packed-smoke:"));
const quality = workflow.slice(
  workflow.indexOf("  npm-quality:"),
  workflow.indexOf("  npm-package-smoke:")
);

const actionReferences = [...smoke.matchAll(/^\s+uses:\s+[^@\s]+@([^\s#]+)/gm)].map(
  ([, reference]) => reference
);

test("Linux remains the required full quality gate", () => {
  assert.match(quality, /runs-on: ubuntu-latest/);
  assert.match(quality, /run: npm run verify/);
  assert.doesNotMatch(quality, /continue-on-error/);
});

test("cross-platform smoke covers clean packed CLI confidence without deployment", () => {
  assert.match(smoke, /macos-latest/);
  assert.match(smoke, /windows-latest/);
  assert.match(smoke, /npm ci --ignore-scripts/);
  assert.match(smoke, /node scripts\/cross-platform-smoke\.mjs/);
  assert.doesNotMatch(smoke, /npm publish|NPM_TOKEN|NODE_AUTH_TOKEN|sudo\b/);
  assert.ok(actionReferences.length > 0);
  for (const reference of actionReferences) {
    assert.match(reference, /^[0-9a-f]{40}$/);
  }
});
