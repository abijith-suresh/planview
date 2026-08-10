import { defineConfig } from "astro/config";

const normalizeBasePath = (value: string | undefined) => {
  const withoutOuterSlashes = value?.replace(/^\/+|\/+$/g, "") ?? "";
  return withoutOuterSlashes ? `/${withoutOuterSlashes}` : "";
};

const { BASE_PATH, GITHUB_REPOSITORY } = process.env;
const repositoryName = GITHUB_REPOSITORY?.split("/").filter(Boolean).at(-1);
const base = normalizeBasePath(BASE_PATH ?? (repositoryName ? `/${repositoryName}` : undefined));

export default defineConfig({
  output: "static",
  base,
});
