import { writeFile } from "node:fs/promises";
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { loadEnv } from "vite";
import { readPublicUrls } from "./src/lib/public-urls.ts";

const urls = readPublicUrls({
  // biome-ignore lint/complexity/useLiteralKeys: Node environment declarations use an index signature.
  ...loadEnv(process.env["NODE_ENV"] ?? "production", process.cwd(), "PUBLIC_"),
  ...process.env,
});

export default defineConfig({
  output: "static",
  site: urls.docsOrigin,
  base: urls.docsBasePath,
  trailingSlash: "always",
  vite: {
    define: {
      "import.meta.env.PUBLIC_APP_URL": JSON.stringify(urls.appUrl),
      "import.meta.env.PUBLIC_SITE_URL": JSON.stringify(urls.siteUrl),
      "import.meta.env.PUBLIC_DOCS_URL": JSON.stringify(urls.docsUrl),
    },
  },
  integrations: [
    starlight({
      title: "plansplease docs",
      description: "Guides for local previews, cloud documents, and MCP agents.",
      customCss: ["./src/styles/docs.css"],
      tableOfContents: false,
      expressiveCode: {
        themes: ["starlight-dark"],
        useDarkModeMediaQuery: false,
        styleOverrides: {
          borderColor: "rgba(255, 255, 255, 0.08)",
          frames: {
            editorBackground: "#121214",
            terminalBackground: "#121214",
            inlineButtonForeground: "#d9d9dc",
            frameBoxShadowCssValue: "none",
          },
        },
      },
      head: [{ tag: "meta", attrs: { name: "theme-color", content: "#0c0c0e" } }],
      components: {
        Header: "./src/components/Header.astro",
        ThemeProvider: "./src/components/DarkTheme.astro",
        ThemeSelect: "./src/components/Empty.astro",
        MobileMenuFooter: "./src/components/Empty.astro",
      },
      editLink: { baseUrl: "https://github.com/abijith-suresh/planview/edit/main/apps/docs/" },
      sidebar: [
        { label: "Get started", slug: "index" },
        {
          label: "Setup",
          items: [
            { label: "Install the CLI", slug: "guides/install-cli" },
            { label: "Connect MCP", slug: "guides/mcp" },
            { label: "Self-hosting", slug: "guides/self-hosting" },
          ],
        },
        {
          label: "Guides",
          collapsed: true,
          items: [{ slug: "guides/cli" }, { slug: "guides/cloud" }, { slug: "guides/agents" }],
        },
        {
          label: "Reference",
          collapsed: true,
          items: [
            { slug: "reference/troubleshooting" },
            { slug: "reference/privacy-and-limits" },
            { slug: "reference/architecture" },
            { slug: "reference/development" },
            { slug: "reference/planned-features" },
          ],
        },
      ],
    }),
    {
      name: "plansplease-docs-runtime",
      hooks: {
        "astro:build:done": async ({ dir }) => {
          await writeFile(
            new URL("docs-runtime.json", dir),
            JSON.stringify({ basePath: urls.docsBasePath })
          );
        },
      },
    },
  ],
});
