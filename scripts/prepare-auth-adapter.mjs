import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appRequire = createRequire(join(root, "apps/app/package.json"));
const entry = appRequire.resolve("@convex-dev/better-auth/plugins");
const file = join(dirname(entry), "convex/index.js");
const source = await readFile(file, "utf8");

const oldImport =
  'import { oidcProvider as oidcProviderPlugin } from "better-auth/plugins/oidc-provider";\n';
const oldInit = `    const oidcProvider = oidcProviderPlugin({
        loginPage: "/not-used",
        metadata: {
            issuer: \`\${process.env.CONVEX_SITE_URL}\`,
            jwks_uri: \`\${process.env.CONVEX_SITE_URL}\${opts.options?.basePath ?? "/api/auth"}/convex/jwks\`,
        },
        __skipDeprecationWarning: true,
    });
`;
const oldHook = "                ...normalizeAfterHooks(oidcProvider.hooks.after),\n";
const oldMetadata = `                const response = await oidcProvider.endpoints.getOpenIdConfig({
                    ...ctx,
                    asResponse: false,
                    returnHeaders: false,
                    returnStatus: false,
                });
                return response;
`;
const currentMetadata = `                return {
                    issuer: process.env.CONVEX_SITE_URL,
                    jwks_uri: \`\${process.env.CONVEX_SITE_URL}/api/auth/convex/jwks\`,
                };
`;

let prepared = source;
if (prepared.includes(oldImport)) {
  if (!source.includes(oldInit) || !source.includes(oldHook) || !source.includes(oldMetadata)) {
    throw new Error("The Convex auth adapter changed; review the Better Auth compatibility patch.");
  }
  prepared = prepared.replace(oldImport, "").replace(oldInit, "").replace(oldHook, "");
}
if (prepared.includes(oldMetadata)) {
  prepared = prepared.replace(oldMetadata, currentMetadata);
}
if (prepared !== source) {
  await writeFile(file, prepared);
  process.stdout.write("Applied Better Auth 1.7 compatibility patch to Convex auth adapter.\n");
}
