import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  external: ["effect"],
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: false,
});

await build({
  entryPoints: ["../../packages/daemon/src/entry.ts"],
  outfile: "dist/daemon.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  external: ["effect"],
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: false,
});
