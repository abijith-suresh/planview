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

// Better Auth 1.7 adds modelKey to adapter calls. The published Convex adapter
// spreads that field into function arguments, but its 0.12.5 validators reject it.
const clientEntry = appRequire.resolve("@convex-dev/better-auth");
const adapterFile = join(dirname(clientEntry), "adapter.js");
const adapterSource = await readFile(adapterFile, "utf8");
const stripModelKey = `const stripUnsupportedModelKey = (value) => {
    const { modelKey: _modelKey, ...rest } = value;
    return rest;
};
`;
const adapterMarker = "export const convexAdapter = (ctx, api, config = {}) => {";

if (!adapterSource.includes(stripModelKey)) {
  const dataSpreads = adapterSource.match(/\.\.\.data,/g)?.length ?? 0;
  const queryDataSpreads = adapterSource.match(/\.\.\.queryData,/g)?.length ?? 0;
  if (!adapterSource.includes(adapterMarker) || dataSpreads !== 7 || queryDataSpreads !== 1) {
    throw new Error("The Convex auth adapter changed; review the modelKey compatibility patch.");
  }
  const patchedAdapter = adapterSource
    .replace(adapterMarker, `${stripModelKey}${adapterMarker}`)
    .replaceAll("...data,", "...stripUnsupportedModelKey(data),")
    .replaceAll("...queryData,", "...stripUnsupportedModelKey(queryData),");
  await writeFile(adapterFile, patchedAdapter);
  process.stdout.write(
    "Applied Better Auth 1.7 modelKey compatibility patch to Convex auth adapter.\n"
  );
}

// Better Auth 1.7 falls back to a read followed by a conditional delete when
// an adapter has no consumeOne method. That fallback includes Convex's
// _creationTime in its guard, which is not a valid Better Auth schema field.
// Convex's deleteOne mutation already reads and deletes in one transaction and
// returns the deleted document, so use it for one-time OAuth codes directly.
const consumeOneMarker = "                delete: async (data) => {";
const consumeOnePatch = `                consumeOne: async (data) => {
                    if (!("runMutation" in ctx)) {
                        throw new Error("ctx is not a mutation ctx");
                    }
                    if (!data.where?.length) {
                        return null;
                    }
                    if (data.where.some((w) => w.connector === "OR")) {
                        throw new Error("where clause not supported");
                    }
                    const onDeleteHandle = config.authFunctions?.onDelete &&
                        config.triggers?.[data.model]?.onDelete
                        ? (await createFunctionHandle(config.authFunctions.onDelete))
                        : undefined;
                    return ctx.runMutation(api.adapter.deleteOne, {
                        input: {
                            model: data.model,
                            where: parseWhere(data.where),
                        },
                        onDeleteHandle: onDeleteHandle,
                    });
                },
`;
const currentAdapterSource = await readFile(adapterFile, "utf8");
if (!currentAdapterSource.includes(consumeOnePatch)) {
  if (currentAdapterSource.includes("                consumeOne: async (data) => {") ||
      currentAdapterSource.split(consumeOneMarker).length !== 2) {
    throw new Error("The Convex auth adapter changed; review the atomic consume patch.");
  }
  await writeFile(
    adapterFile,
    currentAdapterSource.replace(consumeOneMarker, `${consumeOnePatch}${consumeOneMarker}`)
  );
  process.stdout.write("Applied atomic OAuth code consumption patch to Convex auth adapter.\n");
}
