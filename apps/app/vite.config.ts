import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { nitro } from "nitro/vite";

import { solidStart } from "@solidjs/start/config";

const resolveUriEsm = fileURLToPath(
  import.meta.resolve("@jridgewell/resolve-uri/package.json"),
);

export default defineConfig({
  plugins: [solidStart(), nitro()],
  resolve: {
    // The client resolver picks @jridgewell/resolve-uri's browser field (a UMD
    // build with no default export) when the source-map dev toolbar imports
    // trace-mapping; force the ESM build everywhere.
    alias: {
      "@jridgewell/resolve-uri": resolveUriEsm.replace(
        /package\.json$/,
        "dist/resolve-uri.mjs",
      ),
    },
  },
});
