import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const withBuild = ({ outputDirectory, basePath, githubRepository }, check) => {
  const output = resolve(root, outputDirectory);
  rmSync(output, { force: true, recursive: true });

  const environment = { ...process.env, GITHUB_REPOSITORY: githubRepository };
  if (basePath === undefined) {
    delete environment.BASE_PATH;
  } else {
    environment.BASE_PATH = basePath;
  }

  try {
    execFileSync(npm, ["run", "build", "--", "--outDir", outputDirectory], {
      cwd: root,
      env: environment,
      stdio: "ignore",
    });
    check(output);
  } finally {
    rmSync(output, { force: true, recursive: true });
  }
};

const assertSiteBasics = (html) => {
  assert.ok(html.includes('<header class="site-header"'), "the site header should be rendered");
  assert.ok(
    html.includes('<nav aria-label="Main navigation"'),
    "the main navigation should have its accessible label"
  );
  assert.ok(
    html.includes('<main id="main-content" tabindex="-1"'),
    "the skip-link target should be programmatically focusable"
  );
  assert.ok(html.includes('<footer class="site-footer"'), "the site footer should be rendered");

  const skipLinkStart = '<a class="skip-link" href="#main-content"';
  const skipLinkEnd = ">Skip to main content</a>";
  const skipLinkPosition = html.indexOf(skipLinkStart);
  assert.ok(skipLinkPosition >= 0, "the skip link should target main-content");
  assert.equal(html.indexOf(skipLinkStart), html.lastIndexOf(skipLinkStart));
  assert.ok(
    html.indexOf(skipLinkEnd, skipLinkPosition) > skipLinkPosition,
    "the skip link should have its expected accessible name"
  );
  assert.equal(html.includes("astro-island"), false, "the static site should not emit islands");
};

const assertStylesheetAndInternalLinks = (html, output, expectedBase) => {
  const stylesheetMarker = '<link rel="stylesheet" href="';
  const stylesheetStart = html.indexOf(stylesheetMarker);
  assert.ok(stylesheetStart >= 0, "the homepage should link its stylesheet");
  assert.equal(html.indexOf(stylesheetMarker), html.lastIndexOf(stylesheetMarker));

  const stylesheetValueStart = stylesheetStart + stylesheetMarker.length;
  const stylesheetValueEnd = html.indexOf('"', stylesheetValueStart);
  assert.ok(stylesheetValueEnd > stylesheetValueStart, "the stylesheet URL should be quoted");
  assert.equal(html[stylesheetValueEnd + 1], ">");
  const stylesheetHref = html.slice(stylesheetValueStart, stylesheetValueEnd);

  const assetDirectory = resolve(output, "_astro");
  const cssFiles = readdirSync(assetDirectory).filter((file) => file.endsWith(".css"));
  assert.equal(cssFiles.length, 1, "the build should emit one stylesheet asset");
  const expectedStylesheetHref = `${expectedBase}/_astro/${cssFiles[0]}`;
  assert.equal(
    stylesheetHref,
    expectedStylesheetHref,
    "the stylesheet link should exactly match the generated prefixed asset"
  );
  assert.equal(
    html.includes('<link rel="stylesheet" href="/_astro/'),
    expectedBase === "",
    "the stylesheet should not lose its deployment prefix"
  );
  assert.ok(
    existsSync(resolve(assetDirectory, cssFiles[0])),
    "the stylesheet linked by the homepage should exist"
  );

  const expectedHomeHref = expectedBase || "/";
  const wordmarkMarker = `<a class="wordmark" href="${expectedHomeHref}" aria-label="Planview home"`;
  assert.ok(
    html.includes(wordmarkMarker),
    "the home link should exactly use the configured deployment prefix"
  );
};

const assertSkipLinkStyles = (output) => {
  const cssFile = readdirSync(resolve(output, "_astro")).find((file) => file.endsWith(".css"));
  assert.ok(cssFile, "the build should provide CSS for accessibility assertions");
  const css = readFileSync(resolve(output, "_astro", cssFile), "utf8");
  const rules = css.split("}");
  const skipLinkRule = rules.find(
    (rule) => rule.includes(".skip-link[") && !rule.includes(":focus-visible{")
  );
  const focusRule = rules.find(
    (rule) => rule.includes(".skip-link[") && rule.includes(":focus-visible{")
  );

  assert.ok(skipLinkRule, "the skip link should be visually hidden before focus");
  assert.ok(skipLinkRule.includes("transform:translateY(-200%)"));
  assert.ok(focusRule, "the skip link should have a focus-visible rule");
  assert.ok(focusRule.includes("outline:3px solid var(--orange)"));
  assert.ok(focusRule.includes("transform:translateY(0)"));
};

const assertHomepage = (output, expectedBase) => {
  const homepage = resolve(output, "index.html");
  assert.ok(existsSync(homepage), `${output}/index.html should exist after a build`);

  const html = readFileSync(homepage, "utf8");
  assert.ok(html.includes("Planview"));
  assert.ok(html.includes("immutable localhost URL"));
  assertSiteBasics(html);
  assertStylesheetAndInternalLinks(html, output, expectedBase);
  assertSkipLinkStyles(output);
};

test("root static build is hermetic and emits the project homepage", () => {
  withBuild({ outputDirectory: "dist", basePath: "", githubRepository: "" }, (output) =>
    assertHomepage(output, "")
  );
});

test("base-path normalization prefixes exact internal asset and home-link output", () => {
  withBuild(
    {
      outputDirectory: "dist-base",
      basePath: "//planview///",
      githubRepository: "owner/name",
    },
    (output) => assertHomepage(output, "/planview")
  );
});

test("repository name derives the deployment base when BASE_PATH is unset", () => {
  withBuild(
    {
      outputDirectory: "dist-repository",
      basePath: undefined,
      githubRepository: "owner/name",
    },
    (output) => assertHomepage(output, "/name")
  );
});
