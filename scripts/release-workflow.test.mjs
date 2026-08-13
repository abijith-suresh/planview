import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const workflow = readFileSync(resolve(".github", "workflows", "release.yml"), "utf8");

test("release workflow keeps npm auth out of the Changesets version phase", () => {
  const prepare = workflow.slice(0, workflow.indexOf("  publish:"));
  const publish = workflow.slice(workflow.indexOf("  publish:"));

  assert.match(publish, /registry-url: https:\/\/registry\.npmjs\.org/);
  assert.match(publish, /scope: ["']?@abijith-suresh["']?/);
  assert.match(publish, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
  assert.match(
    publish,
    /PLANVIEW_NPM_REGISTRY: \$\{\{ vars\.PLANVIEW_NPM_REGISTRY \|\| ['"]https:\/\/registry\.npmjs\.org['"] \}\}/
  );
  assert.doesNotMatch(prepare, /NPM_TOKEN|NODE_AUTH_TOKEN|registry-url/);
  assert.doesNotMatch(prepare, /publish:/);
});

test("release workflow only publishes a merged canonical same-repository release PR", () => {
  const publish = workflow.slice(workflow.indexOf("  publish:"));
  assert.match(publish, /github\.event\.pull_request\.merged == true/);
  assert.match(publish, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(publish, /github\.event\.pull_request\.head\.ref == 'changeset-release\/main'/);
});

test("release workflow keeps publishing disabled by default", () => {
  assert.match(
    workflow,
    /PLANVIEW_NPM_PUBLISH: \$\{\{ vars\.PLANVIEW_NPM_PUBLISH \|\| ['"]disabled['"] \}\}/
  );
});
