import { defineConfig } from "astro/config";

const normalizeBasePath = (value: string | undefined) => {
  const withoutOuterSlashes = value?.replace(/^\/+|\/+$/g, "") ?? "";
  return withoutOuterSlashes ? `/${withoutOuterSlashes}` : "";
};

const base = normalizeBasePath(process.env["BASE_PATH"]);

export default defineConfig({
  output: "static",
  base,
});
