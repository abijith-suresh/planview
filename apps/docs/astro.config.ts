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
      logo: { src: "./src/assets/mark.svg" },
      customCss: ["./src/styles/docs.css"],
      components: { Header: "./src/components/Header.astro" },
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/abijith-suresh/planview" },
      ],
      editLink: { baseUrl: "https://github.com/abijith-suresh/planview/edit/main/apps/docs/" },
      sidebar: [
        { label: "Start here", items: [{ slug: "index" }, { slug: "getting-started" }] },
        {
          label: "Use plansplease",
          items: [
            { slug: "guides/mcp" },
            { slug: "guides/cli" },
            { slug: "guides/cloud" },
            { slug: "guides/agents" },
          ],
        },
        {
          label: "Understand the system",
          items: [
            { slug: "reference/privacy-and-limits" },
            { slug: "reference/architecture" },
            { slug: "reference/troubleshooting" },
            { slug: "reference/development" },
            { slug: "reference/planned-features" },
          ],
        },
        {
          label: "Product",
          items: [
            { label: "Workspace", link: urls.appUrl },
            { label: "Website", link: urls.siteUrl },
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
