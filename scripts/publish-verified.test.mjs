import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = fileURLToPath(new URL("./publish-verified.mjs", import.meta.url));

const withTarball = (environment, callback) => {
  const directory = mkdtempSync(join(tmpdir(), "planview-publish-verified-"));
  const tarball = join(directory, "verified.tgz");
  writeFileSync(tarball, "not a real tarball; the publisher only checks the verified path");
  try {
    return callback(tarball, {
      ...process.env,
      ...environment,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test("scoped publishing is explicitly disabled by default", () => {
  const result = withTarball({ PLANVIEW_NPM_PUBLISH: "disabled" }, (tarball, env) =>
    spawnSync(process.execPath, [script, tarball], {
      cwd: root,
      env,
      encoding: "utf8",
    })
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /@abijith-suresh\/planview@0\.1\.1/);
  assert.match(result.stdout, /explicitly disabled/);
  assert.doesNotMatch(result.stdout, /npm publish\s/);
});

test("enabled publishing fails closed until npm authentication is configured", () => {
  const result = withTarball(
    { PLANVIEW_NPM_PUBLISH: "enabled", PLANVIEW_NPM_REGISTRY: "https://registry.npmjs.org" },
    (tarball, env) => {
      delete env.NPM_TOKEN;
      delete env.NODE_AUTH_TOKEN;
      return spawnSync(process.execPath, [script, tarball], {
        cwd: root,
        env,
        encoding: "utf8",
      });
    }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /NPM_TOKEN or NODE_AUTH_TOKEN/);
});

test("enabled publishing fails closed until the registry is configured", () => {
  const result = withTarball(
    { PLANVIEW_NPM_PUBLISH: "enabled", NPM_TOKEN: "test-only-token" },
    (tarball, env) => {
      delete env.PLANVIEW_NPM_REGISTRY;
      return spawnSync(process.execPath, [script, tarball], {
        cwd: root,
        env,
        encoding: "utf8",
      });
    }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /PLANVIEW_NPM_REGISTRY/);
});
