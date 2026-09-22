import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const withBuild = ({ outputDirectory, basePath }, check) => {
  const output = resolve(root, outputDirectory);
  rmSync(output, { force: true, recursive: true });

  const environment = { ...process.env };
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
    /<nav[^>]*aria-label="Main navigation"/.test(html),
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
  const stylesheetHrefs = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(
    ([, href]) => href
  );
  assert.ok(stylesheetHrefs.length > 0, "the homepage should link its stylesheet");

  const assetDirectory = resolve(output, "_astro");
  const cssFiles = readdirSync(assetDirectory).filter((file) => file.endsWith(".css"));
  assert.equal(
    stylesheetHrefs.length,
    cssFiles.length,
    "the build should emit and link each stylesheet asset"
  );
  const expectedStylesheetPrefix = `${expectedBase}/_astro/`;
  for (const href of stylesheetHrefs) {
    assert.ok(
      href.startsWith(expectedStylesheetPrefix),
      "the stylesheet should not lose its deployment prefix"
    );
    assert.ok(
      existsSync(resolve(assetDirectory, href.slice(expectedStylesheetPrefix.length))),
      "the stylesheet linked by the homepage should exist"
    );
  }

  const expectedHomeHref = expectedBase || "/";
  const wordmarkMarker = `<a class="brand" href="${expectedHomeHref}" aria-label="plansplease home"`;
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
    (rule) => rule.includes(".skip-link") && !rule.includes(":focus-visible")
  );
  const focusRule = rules.find(
    (rule) => rule.includes(".skip-link") && rule.includes(":focus-visible")
  );

  assert.ok(skipLinkRule, "the skip link should be visually hidden before focus");
  assert.ok(skipLinkRule.includes("transform:translateY(-200%)"));
  assert.ok(focusRule, "the skip link should have a focus-visible rule");
  assert.ok(focusRule.includes("outline:3px solid var(--mint)"));
  assert.ok(focusRule.includes("transform:translateY(0)"));
};

const assertMarketingPages = (output) => {
  const pages = [
    ["features", "Features | plansplease", "A short path from agent output to a page."],
    ["cli", "CLI | plansplease", "Give a local HTML file a URL."],
    ["about", "About | plansplease", "A place for the useful things agents make."],
    ["docs", "Docs | plansplease", "Docs for a small tool."],
    ["pricing", "Pricing | plansplease", "Simple for now. Clear about later."],
    ["faq", "FAQ | plansplease", "Questions we expect to hear."],
    ["privacy", "Privacy | plansplease", "Your pages are yours."],
  ];

  for (const [directory, title, heading] of pages) {
    const page = resolve(output, directory, "index.html");
    assert.ok(existsSync(page), `${directory}/index.html should exist after a build`);

    const html = readFileSync(page, "utf8");
    assert.ok(html.includes(`<title>${title}</title>`), `${directory} should have its page title`);
    assert.ok(html.includes(heading), `${directory} should render its primary heading`);
    assertSiteBasics(html);
    assert.equal(html.includes("<button"), false, `${directory} should not render a button`);
  }
};

const assertHomepage = (output, expectedBase) => {
  const homepage = resolve(output, "index.html");
  assert.ok(existsSync(homepage), `${output}/index.html should exist after a build`);

  const html = readFileSync(homepage, "utf8");
  assert.ok(html.includes("plansplease"));
  assert.ok(html.includes("cloud workspace"));
  assert.ok(html.includes("One HTML file to start"));
  assert.ok(html.includes("Your agent made a page."));
  assert.ok(html.includes("Keep it somewhere useful."));
  assert.ok(html.includes("Continue with GitHub"));
  assert.ok(html.includes("Private cloud workspace. Local CLI included."));
  assert.ok(html.includes("Preview locally"));
  assert.ok(html.includes("Keep a cloud copy"));
  assert.ok(html.includes("app-staging-a39a.up.railway.app/dashboard"));
  assert.ok(html.includes('class="mobile-menu"'));
  assert.ok(html.includes("Pricing"));
  assert.ok(html.includes("Docs"));
  assert.ok(html.includes("FAQ"));
  assert.ok(html.includes('class="site-footer-main"'));
  assert.equal(html.includes("eyebrow"), false);
  assert.equal(html.includes("hero-sticker"), false);
  assert.equal(html.includes("↗"), false);
  assert.equal(html.includes("<button"), false);
  assert.equal(html.includes("share on your network"), false);
  assert.equal(html.includes("permanent address"), false);
  assertSiteBasics(html);
  assertStylesheetAndInternalLinks(html, output, expectedBase);
  assertSkipLinkStyles(output);
  assertMarketingPages(output);
};

test("root static build is hermetic and emits the project homepage", () => {
  withBuild({ outputDirectory: "dist", basePath: "" }, (output) => assertHomepage(output, ""));
});

test("base-path normalization prefixes exact internal asset and home-link output", () => {
  withBuild(
    {
      outputDirectory: "dist-base",
      basePath: "//planview///",
    },
    (output) => assertHomepage(output, "/planview")
  );
});

test("an unset BASE_PATH keeps the site at the domain root", () => {
  withBuild({ outputDirectory: "dist-root", basePath: undefined }, (output) =>
    assertHomepage(output, "")
  );
});
