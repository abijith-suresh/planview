import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);

const workflowFiles = readdirSync(resolve(root, ".github", "workflows"))
  .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
  .map((file) => resolve(root, ".github", "workflows", file));

test("GitHub Actions workflows pass actionlint", (t) => {
  const result = spawnSync("actionlint", workflowFiles, {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error?.code === "ENOENT") {
    t.skip("actionlint is not installed in this environment");
    return;
  }
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
